import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportPilotClient } from '../connectors/report-pilot.js';

function clientWith(routes) {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const r = routes(u.pathname, u.searchParams);
    return { status: r.status, async json() { return r.body; }, async text() { return JSON.stringify(r.body); } };
  };
  return createReportPilotClient({ base: 'https://api.tidjaruad.co', getKey: () => 'rpt_' + 'a'.repeat(24), fetchImpl });
}

test('fetchShopLives returns data.live_stream_sessions with the exclusive month range + account_type filter', async () => {
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/gateway/shop/uuid-1/analytics/202509/shop_lives/performance') {
      seen = Object.fromEntries(q);
      return { status: 200, body: { code: 0, data: { live_stream_sessions: [{ id: '1', username: 'papartor' }, { id: '2', username: 'gyskin' }], total_count: 2, next_page_token: '' } } };
    }
    return { status: 404, body: {} };
  });
  const lives = await c.fetchShopLives('uuid-1', '2026-08', { accountType: 'AFFILIATE_ACCOUNTS' });
  assert.deepEqual(lives.map((l) => l.username), ['papartor', 'gyskin']);
  assert.equal(seen.start_date_ge, '2026-08-01');
  assert.equal(seen.end_date_lt, '2026-09-01');
  assert.equal(seen.account_type, 'AFFILIATE_ACCOUNTS');
  assert.equal(seen.currency, 'LOCAL');
});

test('fetchShopLives follows next_page_token up to maxPages', async () => {
  const pages = { '': { live_stream_sessions: [{ id: '1' }], next_page_token: 't2' }, t2: { live_stream_sessions: [{ id: '2' }], next_page_token: 't3' }, t3: { live_stream_sessions: [{ id: '3' }], next_page_token: '' } };
  const c = clientWith((p, q) => p.endsWith('/shop_lives/performance') ? { status: 200, body: { code: 0, data: pages[q.get('page_token') || ''] } } : { status: 404, body: {} });
  const lives = await c.fetchShopLives('uuid-1', '2026-08', { maxPages: 2 });
  assert.deepEqual(lives.map((l) => l.id), ['1', '2']);
});

test('fetchShopOverview sums gmv + sku_orders across performance intervals for the given kind', async () => {
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/gateway/shop/uuid-1/analytics/202509/shop_videos/overview_performance') {
      seen = Object.fromEntries(q);
      return { status: 200, body: { code: 0, data: { performance: { intervals: [{ gmv: { amount: '7092935.58' }, sku_orders: 22431 }] } } } };
    }
    return { status: 404, body: {} };
  });
  const o = await c.fetchShopOverview('uuid-1', '2026-08', 'videos', { accountType: 'AFFILIATE_ACCOUNTS' });
  assert.equal(o.gmv, 7092935.58);
  assert.equal(o.orders, 22431);
  assert.equal(seen.account_type, 'AFFILIATE_ACCOUNTS');
});

test('fetchShopCount returns total_count from a page_size:1 list call (the "carrying a product" proxy)', async () => {
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/gateway/shop/uuid-1/analytics/202509/shop_lives/performance') { seen = Object.fromEntries(q); return { status: 200, body: { code: 0, data: { live_stream_sessions: [{}], total_count: 7901 } } }; }
    return { status: 404, body: {} };
  });
  const n = await c.fetchShopCount('uuid-1', '2026-08', 'lives', { accountType: 'AFFILIATE_ACCOUNTS' });
  assert.equal(n, 7901);
  assert.equal(seen.page_size, '1');
});

test('fetchShopLives throws TT_ERROR on a non-zero TikTok code', async () => {
  const c = clientWith(() => ({ status: 200, body: { code: 99, message: 'nope' } }));
  await assert.rejects(() => c.fetchShopLives('uuid-1', '2026-08'), (e) => e.code === 'TT_ERROR');
});
