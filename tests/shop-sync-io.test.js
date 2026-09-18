import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncShopMetrics } from '../lib/shop-sync.js';

test('syncShopMetrics fetches, maps, and upserts m039_shops then m039_shop_monthly', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const client = { fetchShopMetrics: async () => ({ shops: [{ shop_code: 'S1', shop_name: 'S', metrics: { gmv: 5 } }], total: {} }) };
  const writes = [];
  const fakeFetch = async (url, opts) => { writes.push({ url: String(url), method: opts.method }); return { status: 201, async text() { return ''; } }; };
  const res = await syncShopMetrics({ cfg, client, month: '2026-09', fetchImpl: fakeFetch });
  assert.equal(res.ok, true); assert.equal(res.synced, 1);
  const shops = writes.findIndex((w) => w.url.includes('/m039_shops') && w.method === 'POST');
  const monthly = writes.findIndex((w) => w.url.includes('/m039_shop_monthly') && w.method === 'POST');
  assert.ok(shops >= 0 && monthly >= 0);
  assert.ok(shops < monthly, 'parent m039_shops upserted before FK child');
});

test('syncShopMetrics forwards include to the connector, and asks for nothing extra by default', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const calls = [];
  const client = { fetchShopMetrics: async (month, opts) => { calls.push([month, opts]); return { shops: [], total: {} }; } };
  const fakeFetch = async () => ({ status: 201, async text() { return ''; } });
  await syncShopMetrics({ cfg, client, month: '2026-09', fetchImpl: fakeFetch });
  await syncShopMetrics({ cfg, client, month: '2026-08', include: 'lives', fetchImpl: fakeFetch });
  assert.deepEqual(calls[0], ['2026-09', { include: '' }]);
  assert.deepEqual(calls[1], ['2026-08', { include: 'lives' }]);
});
