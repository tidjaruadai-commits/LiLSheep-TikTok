import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveCovers } from '../lib/cover-archive.js';

test('archiveCovers downloads a fresh cover, uploads to m039-covers, and rewrites cover_url', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j', coversBucket: 'm039-covers' };
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ u, method: opts.method || 'GET', headers: opts.headers || {} });
    if (u.includes('/rest/v1/m039_ads_items') && (opts.method || 'GET') === 'GET')
      return { status: 200, async text() { return JSON.stringify([{ id: 1, ad_id: 'a1', cover_url: 'https://p16-tiktokcdn.com/x.jpg' }]); } };
    if (u.includes('tiktokcdn')) return { status: 200, headers: { get: () => 'image/jpeg' }, async arrayBuffer() { return new ArrayBuffer(4); } };
    if (u.includes('/storage/v1/object/m039-covers/')) return { status: 200, async text() { return ''; } };
    if (u.includes('/rest/v1/m039_ads_items') && opts.method === 'PATCH') return { status: 204, async text() { return ''; } };
    return { status: 404, async text() { return ''; } };
  };
  const res = await archiveCovers({ cfg, fetchImpl: fakeFetch });
  assert.equal(res.ok, true); assert.equal(res.archived, 1);
  const upload = calls.find((c) => c.u.includes('/storage/v1/object/m039-covers/a1.jpg') && c.method === 'POST');
  assert.ok(upload, 'uploaded to the m039-covers bucket');
  assert.equal(upload.headers.Authorization, 'Bearer j', 'upload carries the m039_app Bearer (never anon)');
  assert.equal(upload.headers.apikey, 'a');
  assert.ok(calls.some((c) => c.u.includes('/rest/v1/m039_ads_items?id=eq.1') && c.method === 'PATCH'));
});

test('archiveCovers stops at budgetMs and reports the remainder (a serverless run must return before it is killed)', async () => {
  // Live 2026-09-12: 87 covers took 149s and pushed the whole sync to 286s of Vercel's 300s.
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j', coversBucket: 'm039-covers' };
  const rows = [1, 2, 3].map((i) => ({ id: i, ad_id: `a${i}`, cover_url: `https://tiktokcdn.com/${i}.jpg` }));
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/m039_ads_items') && (opts.method || 'GET') === 'GET') return { status: 200, async text() { return JSON.stringify(rows); } };
    if (u.includes('tiktokcdn')) { await new Promise((r) => setTimeout(r, 30)); return { status: 200, headers: { get: () => 'image/jpeg' }, async arrayBuffer() { return new ArrayBuffer(4); } }; }
    if (u.includes('/storage/v1/object/m039-covers/')) return { status: 200, async text() { return ''; } };
    if (opts.method === 'PATCH') return { status: 204, async text() { return ''; } };
    return { status: 404, async text() { return ''; } };
  };
  const res = await archiveCovers({ cfg, fetchImpl: fakeFetch, budgetMs: 20 });   // first download alone exceeds it
  assert.equal(res.ok, true);
  assert.equal(res.archived, 1, 'the row already in flight completes; no new row starts past the budget');
  assert.equal(res.remaining, 2);
  assert.equal(res.stopped, 'budget');
  const unbounded = await archiveCovers({ cfg, fetchImpl: fakeFetch });   // default: no budget, all rows
  assert.equal(unbounded.archived, 3); assert.equal(unbounded.remaining, 0); assert.equal(unbounded.stopped, undefined);
});

test('an expired cover (download not ok) is skipped, not archived', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j', coversBucket: 'm039-covers' };
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/m039_ads_items') && (opts.method || 'GET') === 'GET')
      return { status: 200, async text() { return JSON.stringify([{ id: 2, ad_id: 'a2', cover_url: 'https://tiktokcdn.com/gone.jpg' }]); } };
    if (u.includes('tiktokcdn')) return { status: 403, async text() { return ''; } };
    return { status: 404, async text() { return ''; } };
  };
  const res = await archiveCovers({ cfg, fetchImpl: fakeFetch });
  assert.equal(res.archived, 0); assert.equal(res.expired, 1);
});
