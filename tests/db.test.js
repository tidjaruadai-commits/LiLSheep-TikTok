import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeaders, restUrl, dbFetch } from '../lib/db.js';

const CFG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon-key', m039Jwt: 'jwt-token' };

test('buildHeaders sends anon as apikey and the m039 JWT as Bearer', () => {
  const h = buildHeaders(CFG);
  assert.equal(h.apikey, 'anon-key');
  assert.equal(h.Authorization, 'Bearer jwt-token');
});

test('buildHeaders throws (fail-closed) when the Bearer JWT is missing', () => {
  assert.throws(() => buildHeaders({ ...CFG, m039Jwt: '' }), /Bearer|m039_app|JWT/i);
});

test('restUrl builds a PostgREST table URL', () => {
  assert.equal(restUrl(CFG, 'm039_shops', 'select=*'), 'https://x.supabase.co/rest/v1/m039_shops?select=*');
});

test('dbFetch injects headers and returns {status, body}', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    // dbFetch parses the body from text(); keep the fixture self-consistent.
    return { status: 200, async text() { return JSON.stringify([{ ok: true }]); } };
  };
  const res = await dbFetch(CFG, '/rest/v1/m039_shops?select=*', {}, fakeFetch);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ ok: true }]);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer jwt-token');
});
