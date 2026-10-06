import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapProducts, syncProducts } from '../lib/product-sync.js';
import { TIKTOK_OUTSIDE_LOOKBACK } from '../connectors/report-pilot.js';

const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };

function recorder(status = 201) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { calls.push({ url: String(url), method: opts.method, body: opts.body }); return { status, async text() { return ''; } }; };
  return { calls, fetchImpl };
}

test('mapProducts builds one row per product id, rounds money, defaults missing numbers to 0', () => {
  const rows = mapProducts('2026-09', [
    { id: 'p1', name: 'Sleep Well', gmv: 30000.456, orders: 300.4, items_sold: 410 },
    { id: 'p2', name: 'No sales fields', gmv: null, orders: null, items_sold: null },
    { id: 'p1', name: 'duplicate id', gmv: 1, orders: 1, items_sold: 1 },
    { id: '', name: 'no id', gmv: 5 },
  ]);
  assert.equal(rows.length, 2, 'duplicate and id-less rows dropped');
  assert.deepEqual(rows[0], { month: '2026-09', product_id: 'p1', name: 'Sleep Well', gmv: 30000.46, orders: 300, items_sold: 410 });
  assert.deepEqual(rows[1], { month: '2026-09', product_id: 'p2', name: 'No sales fields', gmv: 0, orders: 0, items_sold: 0 });
});

test('syncProducts upserts the month then deletes products this run no longer returned', async () => {
  const { calls, fetchImpl } = recorder();
  const client = { fetchShopProducts: async () => ({ version: '202509', truncated: false, products: [
    { id: 'p1', name: 'A', gmv: 100, orders: 1, items_sold: 1 }, { id: 'p2', name: 'B', gmv: 50, orders: 1, items_sold: 1 },
  ] }) };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results[0], { month: '2026-09', products: 2, gmv: 150, version: '202509', ok: true });

  const up = calls.find((c) => c.method === 'POST');
  assert.match(up.url, /\/m039_product_monthly\?on_conflict=month,product_id/);
  const body = JSON.parse(up.body);
  assert.equal(body.length, 2);
  assert.ok(body.every((r) => r.synced_at), 'every row carries this run stamp');

  const del = calls.find((c) => c.method === 'DELETE');
  assert.match(del.url, /m039_product_monthly\?month=eq\.2026-09&synced_at=lt\./);
  assert.ok(calls.indexOf(up) < calls.indexOf(del), 'upsert first, then the stale delete');
});

test('an empty list from TikTok is skipped, never allowed to delete the stored products', async () => {
  const { calls, fetchImpl } = recorder();
  const client = { fetchShopProducts: async () => ({ version: '202509', truncated: false, products: [] }) };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results[0], { month: '2026-09', products: 0, skipped: 'no-products' });
  assert.equal(calls.length, 0, 'no write and no delete');
});

test('a month past TikTok\'s lookback wall is skipped, not reported as a failure', async () => {
  const { fetchImpl } = recorder();
  const err = Object.assign(new Error('outside lookback'), { code: 'TT_ERROR', ttCode: TIKTOK_OUTSIDE_LOOKBACK });
  const client = { fetchShopProducts: async () => { throw err; } };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-01'], fetchImpl });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results[0], { month: '2026-01', skipped: 'outside-tiktok-window' });
});

test('an ordinary failure is an error, and one bad month does not stop the next', async () => {
  const { fetchImpl } = recorder();
  const client = { fetchShopProducts: async (cid, month) => {
    if (month === '2026-08') throw new Error('shop_products ใช้ไม่ได้ — 202509: boom | 202405: boom');
    return { version: '202405', truncated: false, products: [{ id: 'p1', name: 'A', gmv: 10, orders: 1, items_sold: 1 }] };
  } };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-08', '2026-09'], fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.results[0].error, /202509: boom/);
  assert.equal(res.results[1].ok, true);
});

test('a db write failure is reported as that month\'s error', async () => {
  const { fetchImpl } = recorder(500);
  const client = { fetchShopProducts: async () => ({ version: '202509', truncated: false, products: [{ id: 'p1', name: 'A', gmv: 10, orders: 1, items_sold: 1 }] }) };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.results[0].error, /HTTP 500/);
});

test('a truncated page is flagged in the result', async () => {
  const { fetchImpl } = recorder();
  const client = { fetchShopProducts: async () => ({ version: '202509', truncated: true, products: [{ id: 'p1', name: 'A', gmv: 10, orders: 1, items_sold: 1 }] }) };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.results[0].truncated, true);
});

test('a malformed month is rejected without calling TikTok', async () => {
  const { fetchImpl } = recorder();
  const client = { fetchShopProducts: async () => { throw new Error('must not be called'); } };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-13'], fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.results[0].error, 'bad month');
});
