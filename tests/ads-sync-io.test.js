import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncAds } from '../lib/ads-sync.js';

test('syncAds provisions the account, skips noData, upserts items BEFORE deleting stale', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const client = {
    fetchAdsMetrics: async (adv, y, m) => (m === 9
      ? { client_name: 'Lilsheep', results_by_type: [{ type: 'conversion', label: 'Conv' }],
          projects: [{ campaign_type: 'conversion', spend: 10, top_cost_ads: [{ ad_id: 'a1', ad_name: 'A' }] }] }
      : { noData: true }),
  };
  const writes = [];
  const fakeFetch = async (url, opts) => { writes.push({ url: String(url), method: opts.method }); return { status: 201, async text() { return ''; } }; };
  const res = await syncAds({ cfg, client, advertiserIds: ['7218'], months: ['2026-09', '2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  const idx = (pred) => writes.findIndex(pred);
  const account = idx((w) => w.url.includes('/m039_ad_accounts'));
  const monthly = idx((w) => w.url.includes('/m039_ads_monthly') && w.method === 'POST');
  const itemsPost = idx((w) => w.url.includes('/m039_ads_items') && w.method === 'POST');
  const staleDelete = idx((w) => w.url.includes('/m039_ads_items') && w.method === 'DELETE');
  assert.ok(account >= 0 && monthly >= 0 && itemsPost >= 0 && staleDelete >= 0);
  assert.ok(itemsPost < staleDelete, 'items upserted before stale delete');
  assert.ok(writes.some((w) => w.url.includes('ad_id=not.in.')), 'stale delete scopes to current ad_ids');
  assert.equal(res.results.find((r) => r.month === '2026-08').skipped, 'no-data');
});

test('syncAds reads already-archived covers for the month and upserts items with those URLs kept', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const archived = 'https://x.supabase.co/storage/v1/object/public/m039-covers/a1.jpg';
  const client = {
    fetchAdsMetrics: async () => ({ results_by_type: [], projects: [{ campaign_type: 'reach', spend: 1,
      top_cost_ads: [{ ad_id: 'a1', thumbnail_url: 'https://p16-tiktokcdn.com/fresh-a1.jpg' }, { ad_id: 'a2', thumbnail_url: 'https://p16-tiktokcdn.com/a2.jpg' }] }] }),
  };
  const writes = [];
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url); const method = opts.method || 'GET';
    writes.push({ url: u, method, body: opts.body });
    if (u.includes('/m039_ads_items') && method === 'GET') {
      assert.match(u, /month=eq\.2026-09/); assert.match(u, /advertiser_id=eq\.7218/); assert.match(u, /m039-covers/);
      return { status: 200, async text() { return JSON.stringify([{ ad_id: 'a1', cover_url: archived }]); } };
    }
    return { status: 201, async text() { return ''; } };
  };
  const res = await syncAds({ cfg, client, advertiserIds: ['7218'], months: ['2026-09'], fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  const read = writes.findIndex((w) => w.url.includes('/m039_ads_items') && w.method === 'GET');
  const post = writes.findIndex((w) => w.url.includes('/m039_ads_items') && w.method === 'POST');
  assert.ok(read >= 0 && post > read, 'existing archived covers are read BEFORE the items upsert');
  const rows = JSON.parse(writes[post].body);
  assert.equal(rows.find((r) => r.ad_id === 'a1').cover_url, archived, 'archived cover kept');
  assert.equal(rows.find((r) => r.ad_id === 'a2').cover_url, 'https://p16-tiktokcdn.com/a2.jpg', 'new clip keeps its CDN cover');
});

test('syncAds merges the raw-report engagement split into each objective row before upserting', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const client = {
    fetchAdsMetrics: async () => ({ results_by_type: [{ type: 'video_view', label: 'Video Views' }],
      projects: [{ campaign_type: 'video_view', spend: 100, video_6s: 900, video_15s: 400, video_completed: 200,
        campaigns: [{ campaign_id: 'c1' }, { campaign_id: 'c2' }], top_cost_ads: [] }] }),
    fetchAdReport: async () => ([
      { dimensions: { campaign_id: 'c1' }, metrics: { likes: '80', comments: '2', shares: '3', profile_visits: '40' } },
      { dimensions: { campaign_id: 'c2' }, metrics: { likes: '20', comments: '1', shares: '0', profile_visits: '10' } },
      { dimensions: { campaign_id: 'zz' }, metrics: { likes: '999', comments: '9', shares: '9', profile_visits: '9' } }, // unmapped -> ignored
    ]),
  };
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method || 'GET', body: opts.body }); return { status: 201, async text() { return ''; } }; };
  const res = await syncAds({ cfg, client, advertiserIds: ['7218'], months: ['2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  const post = writes.find((w) => w.url.includes('/m039_ads_monthly') && w.method === 'POST');
  const row = JSON.parse(post.body)[0];
  assert.equal(row.video_6s, 900); assert.equal(row.video_15s, 400); assert.equal(row.video_completed, 200);
  assert.equal(row.likes, 100); assert.equal(row.comments, 3); assert.equal(row.shares, 3); assert.equal(row.profile_visits, 50);
});

test('syncAds still upserts the objective rows when the engagement report fails (split stays 0, never blocks the month)', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const client = {
    fetchAdsMetrics: async () => ({ results_by_type: [], projects: [{ campaign_type: 'video_view', spend: 5, video_6s: 10, campaigns: [{ campaign_id: 'c1' }], top_cost_ads: [] }] }),
    fetchAdReport: async () => { throw new Error('report 500'); },
  };
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method || 'GET', body: opts.body }); return { status: 201, async text() { return ''; } }; };
  const res = await syncAds({ cfg, client, advertiserIds: ['7218'], months: ['2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, true, 'a failed engagement report does not fail the month');
  const post = writes.find((w) => w.url.includes('/m039_ads_monthly') && w.method === 'POST');
  const row = JSON.parse(post.body)[0];
  assert.equal(row.video_6s, 10); assert.equal(row.likes, 0, 'split stays at seeded 0');
});

test('syncAds isolates a per-month failure and keeps going', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const client = { fetchAdsMetrics: async () => { throw new Error('boom'); } };
  const fakeFetch = async () => ({ status: 201, async text() { return ''; } });
  const res = await syncAds({ cfg, client, advertiserIds: ['7218'], months: ['2026-09', '2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, false);
  assert.equal(res.results.length, 2);
  assert.ok(res.results.every((r) => r.error === 'boom'));
});
