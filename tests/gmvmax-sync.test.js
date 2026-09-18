import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapGmvMaxRows, syncGmvMax } from '../lib/gmvmax-sync.js';

test('mapGmvMaxRows builds the LIVE and PRODUCT upsert rows for one store/month', () => {
  const rows = mapGmvMaxRows('2026-08', '7218524808659615746', '7494836523330930707', {
    LIVE: { cost: 2800358, net_cost: 2700000, gross_revenue: 11706906, roi: 4.18, orders: 29912 },
    PRODUCT: { cost: 3586600, net_cost: 3400000, gross_revenue: 11487792, roi: 3.2, orders: 30793 },
  });
  assert.equal(rows.length, 2);
  const live = rows.find((r) => r.promotion_type === 'LIVE');
  const product = rows.find((r) => r.promotion_type === 'PRODUCT');
  assert.deepEqual(live, {
    month: '2026-08', advertiser_id: '7218524808659615746', store_id: '7494836523330930707',
    promotion_type: 'LIVE', cost: 2800358, net_cost: 2700000, gross_revenue: 11706906, roi: 4.18, orders: 29912,
  });
  assert.deepEqual(product, {
    month: '2026-08', advertiser_id: '7218524808659615746', store_id: '7494836523330930707',
    promotion_type: 'PRODUCT', cost: 3586600, net_cost: 3400000, gross_revenue: 11487792, roi: 3.2, orders: 30793,
  });
});

test('mapGmvMaxRows defaults a missing orders/roi to 0 rather than throwing', () => {
  const rows = mapGmvMaxRows('2026-08', 'adv', 'store', { LIVE: { cost: 0, net_cost: 0, gross_revenue: 0, roi: 0, orders: 0 }, PRODUCT: { cost: 10, net_cost: 10, gross_revenue: 0, roi: 0, orders: 0 } });
  assert.equal(rows[0].orders, 0);
  assert.equal(rows[1].cost, 10);
});

test('syncGmvMax discovers gmv-max stores per advertiser, fetches LIVE+PRODUCT per store/month, and upserts both rows together', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const client = {
    getGmvMaxStores: async () => [{ store_id: '7494836523330930707', store_name: 'Lilsheep', is_gmv_max_available: true }],
    fetchGmvMax: async (adv, storeId, month, type) => (type === 'LIVE'
      ? { cost: 100, net_cost: 90, gross_revenue: 400, roi: 4, orders: 10 }
      : { cost: 50, net_cost: 45, gross_revenue: 100, roi: 2, orders: 5 }),
  };
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method, body: opts.body }); return { status: 201, async text() { return ''; } }; };
  const res = await syncGmvMax({ cfg, client, advertiserIds: ['7218524808659615746'], months: ['2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  const post = writes.find((w) => w.url.includes('/m039_gmvmax_monthly') && w.method === 'POST');
  assert.ok(post, 'upserted m039_gmvmax_monthly');
  assert.match(post.url, /on_conflict=month,advertiser_id,store_id,promotion_type/);
  const rows = JSON.parse(post.body);
  assert.equal(rows.length, 2, 'LIVE + PRODUCT upserted together in one call');
  assert.ok(rows.every((r) => r.store_id === '7494836523330930707' && r.advertiser_id === '7218524808659615746' && r.month === '2026-08'));
  assert.ok(rows.some((r) => r.promotion_type === 'LIVE' && r.cost === 100 && r.gross_revenue === 400));
  assert.ok(rows.some((r) => r.promotion_type === 'PRODUCT' && r.cost === 50 && r.gross_revenue === 100));
  assert.equal(res.results.length, 1);
  assert.deepEqual(res.results[0], { advertiserId: '7218524808659615746', storeId: '7494836523330930707', month: '2026-08', ok: true });
});

test('syncGmvMax skips stores that are not gmv-max-available (connector already filters, but a defensive skip on missing store_id)', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const client = {
    getGmvMaxStores: async () => [{ store_name: 'no id here' }],   // missing store_id
    fetchGmvMax: async () => { throw new Error('must not be called for a store with no id'); },
  };
  const fakeFetch = async () => ({ status: 201, async text() { return ''; } });
  const res = await syncGmvMax({ cfg, client, advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results, []);
});

test('syncGmvMax isolates a failed advertiser (store discovery throws) and a failed store/month (fetch throws): both never abort the rest', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const client = {
    getGmvMaxStores: async (adv) => {
      if (adv === 'bad-adv') throw new Error('advertiser not found');
      return [{ store_id: 's1' }];
    },
    fetchGmvMax: async (adv, storeId, month) => {
      if (month === '2026-07') throw new Error('gateway stalled');
      return { cost: 1, net_cost: 1, gross_revenue: 1, roi: 1, orders: 1 };
    },
  };
  const fakeFetch = async () => ({ status: 201, async text() { return ''; } });
  const res = await syncGmvMax({ cfg, client, advertiserIds: ['bad-adv', 'good-adv'], months: ['2026-08', '2026-07'], fetchImpl: fakeFetch });
  assert.equal(res.ok, false);
  assert.ok(res.results.some((r) => r.advertiserId === 'bad-adv' && r.error === 'advertiser not found'));
  assert.ok(res.results.some((r) => r.advertiserId === 'good-adv' && r.storeId === 's1' && r.month === '2026-08' && r.ok === true));
  assert.ok(res.results.some((r) => r.advertiserId === 'good-adv' && r.storeId === 's1' && r.month === '2026-07' && r.error === 'gateway stalled'));
});

test('syncGmvMax isolates a failed upsert (db write error) without stopping other store/months', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const client = {
    getGmvMaxStores: async () => [{ store_id: 's1' }, { store_id: 's2' }],
    fetchGmvMax: async () => ({ cost: 1, net_cost: 1, gross_revenue: 1, roi: 1, orders: 1 }),
  };
  const fakeFetch = async (url, opts = {}) => {
    if (opts.method === 'POST' && String(url).includes('/m039_gmvmax_monthly')) {
      const rows = JSON.parse(opts.body);
      if (rows.some((r) => r.store_id === 's1')) return { status: 500, async text() { return '{"error":"db down"}'; } };
    }
    return { status: 201, async text() { return ''; } };
  };
  const res = await syncGmvMax({ cfg, client, advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, false);
  assert.ok(res.results.some((r) => r.storeId === 's1' && r.error));
  assert.ok(res.results.some((r) => r.storeId === 's2' && r.ok === true), 's2 still processed after s1 failed');
});
