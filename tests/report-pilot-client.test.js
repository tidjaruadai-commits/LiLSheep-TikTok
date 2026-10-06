import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportPilotClient, readShopProduct, readProductImageUrl, TIKTOK_OUTSIDE_LOOKBACK } from '../connectors/report-pilot.js';

function clientWith(routes) {
  // routes: (path, search) => { status, body }
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const r = routes(u.pathname, u.searchParams);
    return { status: r.status, async json() { return r.body; }, async text() { return JSON.stringify(r.body); } };
  };
  return createReportPilotClient({ base: 'https://api.tidjaruad.co', getKey: () => 'rpt_' + 'a'.repeat(24), fetchImpl });
}

test('getClientId reads clients[0].id', async () => {
  const c = clientWith((p) => p === '/clients/' ? { status: 200, body: [{ id: 'uuid-1', accounts: [] }] } : { status: 404, body: {} });
  assert.equal(await c.getClientId(), 'uuid-1');
});

test('getAdvertiserIds reads accounts[].advertiser_id (no gateway discovery)', async () => {
  const c = clientWith((p) => p === '/clients/'
    ? { status: 200, body: [{ id: 'uuid-1', accounts: [{ advertiser_id: '7218524808659615746' }, { advertiser_id: '999' }] }] }
    : { status: 404, body: {} });
  assert.deepEqual(await c.getAdvertiserIds(), ['7218524808659615746', '999']);
});

test('fetchShopMetrics sends the exclusive month range and NO include by default', async () => {
  // include=products makes Report Pilot page through EVERY order of the month (minutes on a busy
  // shop — it blew Vercel's 300s budget before the first write). The core sync must stay light.
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/clients/') return { status: 200, body: [{ id: 'uuid-1' }] };
    if (p === '/shop-metrics/uuid-1') { seen = Object.fromEntries(q); return { status: 200, body: { shops: [], total: {} } }; }
    return { status: 404, body: {} };
  });
  await c.fetchShopMetrics('2026-09');
  assert.equal(seen.start, '2026-09-01');
  assert.equal(seen.end, '2026-10-01');
  assert.equal(seen.include, undefined);
});

test('fetchShopMetrics sends include only when asked, normalized to the parts the gateway knows', async () => {
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/clients/') return { status: 200, body: [{ id: 'uuid-1' }] };
    if (p === '/shop-metrics/uuid-1') { seen = Object.fromEntries(q); return { status: 200, body: { shops: [], total: {} } }; }
    return { status: 404, body: {} };
  });
  await c.fetchShopMetrics('2026-09', { include: 'lives' });
  assert.equal(seen.include, 'lives');
  await c.fetchShopMetrics('2026-09', { include: ' LIVES, products ,bogus' });
  assert.equal(seen.include, 'products,lives');   // unknown parts dropped (the gateway 422s on them)
  await c.fetchShopMetrics('2026-09', { include: 'bogus' });
  assert.equal(seen.include, undefined);
});

test('a gateway call that stalls past timeoutMs rejects with RP_TIMEOUT instead of hanging the function', async () => {
  // Real fetch rejects with a TimeoutError when its AbortSignal fires; mimic that.
  const fetchImpl = (url, opts) => new Promise((_, reject) => {
    assert.ok(opts.signal, 'every gateway call carries an abort signal');
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
  });
  const c = createReportPilotClient({ getKey: () => 'rpt_' + 'a'.repeat(24), fetchImpl, timeoutMs: 20 });
  await assert.rejects(() => c.getClientId(), (e) => e.code === 'RP_TIMEOUT' && /วินาที/.test(e.message));
  await assert.rejects(() => c.fetchAdsMetrics('123', 2026, 9), (e) => e.code === 'RP_TIMEOUT');
});

test('fetchAdsMetrics returns {noData:true} on the no-campaign 422, throws on other 422', async () => {
  const noCampaign = clientWith((p) => p.startsWith('/ad-accounts/') ? { status: 422, body: { detail: 'บัญชีนี้ไม่มีแคมเปญ' } } : { status: 200, body: [{ id: 'u' }] });
  assert.deepEqual(await noCampaign.fetchAdsMetrics('123', 2026, 9), { noData: true });

  const badReq = clientWith((p) => p.startsWith('/ad-accounts/') ? { status: 422, body: { detail: 'field required' } } : { status: 200, body: [{ id: 'u' }] });
  await assert.rejects(() => badReq.fetchAdsMetrics('123', 2026, 9));
});

test('a 401 from the gateway throws an RP_AUTH error', async () => {
  const c = clientWith(() => ({ status: 401, body: { detail: 'nope' } }));
  await assert.rejects(() => c.getClientId(), (e) => e.code === 'RP_AUTH');
});

test('getGmvMaxStores sends advertiser_id + page_size and keeps only is_gmv_max_available stores', async () => {
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/gateway/ads/gmv_max/store/list/') {
      seen = Object.fromEntries(q);
      return {
        status: 200,
        body: {
          code: 0, message: 'OK',
          // NOTE: TikTok's real response nests these under data.store_list (verified live against
          // the gateway) — NOT data.list, which is only the shape of the report/get/ endpoint below.
          data: { store_list: [
            { store_id: '7494836523330930707', store_name: 'Lilsheep', is_gmv_max_available: true, store_authorized_bc_id: 'bc1' },
            { store_id: '111', store_name: 'Not enabled', is_gmv_max_available: false },
          ] },
        },
      };
    }
    return { status: 404, body: {} };
  });
  const stores = await c.getGmvMaxStores('7218524808659615746');
  assert.equal(seen.advertiser_id, '7218524808659615746');
  assert.equal(seen.page_size, '50');
  assert.deepEqual(stores.map((s) => s.store_id), ['7494836523330930707']);
});

test('getGmvMaxStores throws TT_ERROR when the gateway/TikTok returns code !== 0', async () => {
  const c = clientWith(() => ({ status: 200, body: { code: 40001, message: 'Invalid advertiser_id', data: {} } }));
  await assert.rejects(() => c.getGmvMaxStores('bad'), (e) => e.code === 'TT_ERROR' && /Invalid advertiser_id/.test(e.message));
});

test('fetchGmvMax sends the exact gmv_max report params (inclusive month range, JSON-string arrays) and sums string metrics', async () => {
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/gateway/ads/gmv_max/report/get/') {
      seen = Object.fromEntries(q);
      return {
        status: 200,
        body: {
          code: 0, message: 'OK',
          data: { list: [
            { dimensions: { campaign_id: 'c1' }, metrics: { cost: '100.50', net_cost: '90', gross_revenue: '400', roi: '4.0', orders: '10' } },
            { dimensions: { campaign_id: 'c2' }, metrics: { cost: '50', net_cost: '45', gross_revenue: '100', roi: '2.0', orders: '5' } },
          ] },
        },
      };
    }
    return { status: 404, body: {} };
  });
  const agg = await c.fetchGmvMax('7218524808659615746', '7494836523330930707', '2026-08', 'LIVE');
  assert.equal(seen.advertiser_id, '7218524808659615746');
  assert.equal(seen.store_ids, JSON.stringify(['7494836523330930707']));
  assert.equal(seen.start_date, '2026-08-01');
  assert.equal(seen.end_date, '2026-08-31');   // INCLUSIVE end, unlike fetchShopMetrics
  assert.equal(seen.dimensions, JSON.stringify(['campaign_id']));
  assert.equal(seen.metrics, JSON.stringify(['cost', 'net_cost', 'gross_revenue', 'roi', 'orders']));
  assert.equal(seen.page_size, '1000');
  assert.equal(seen.filtering, JSON.stringify({ gmv_max_promotion_types: ['LIVE'] }));
  // string metrics SUMMED (not concatenated), roi RECOMPUTED from totals, not averaged from '4.0'/'2.0'
  assert.equal(agg.cost, 150.5);
  assert.equal(agg.net_cost, 135);
  assert.equal(agg.gross_revenue, 500);
  assert.equal(agg.orders, 15);
  assert.equal(agg.roi, 3.32);   // round2(500 / 150.5), NOT (4.0+2.0)/2
  assert.equal(agg.campaigns, 2);
});

test('fetchGmvMax sends gmv_max_promotion_types:["PRODUCT"] for the PRODUCT filter', async () => {
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/gateway/ads/gmv_max/report/get/') { seen = Object.fromEntries(q); return { status: 200, body: { code: 0, data: { list: [] } } }; }
    return { status: 404, body: {} };
  });
  await c.fetchGmvMax('adv', 'store', '2026-08', 'PRODUCT');
  assert.equal(seen.filtering, JSON.stringify({ gmv_max_promotion_types: ['PRODUCT'] }));
});

test('fetchGmvMax returns all-zero aggregates for an empty report list (never divide-by-zero on roi)', async () => {
  const c = clientWith((p) => p === '/gateway/ads/gmv_max/report/get/' ? { status: 200, body: { code: 0, data: { list: [] } } } : { status: 404, body: {} });
  const agg = await c.fetchGmvMax('adv', 'store', '2026-08', 'PRODUCT');
  assert.deepEqual(agg, { cost: 0, net_cost: 0, gross_revenue: 0, roi: 0, orders: 0, campaigns: 0 });
});

test('fetchGmvMax throws TT_ERROR when the gateway/TikTok returns code !== 0', async () => {
  const c = clientWith(() => ({ status: 200, body: { code: 40002, message: 'store not gmv-max enabled' } }));
  await assert.rejects(() => c.fetchGmvMax('adv', 'store', '2026-08', 'LIVE'), (e) => e.code === 'TT_ERROR' && /store not gmv-max enabled/.test(e.message));
});

test('fetchAdReport pulls the integrated report across ALL pages and sends the engagement metrics per campaign', async () => {
  const seen = [];
  const c = clientWith((p, q) => {
    if (p === '/gateway/ads/report/integrated/get/') {
      const params = Object.fromEntries(q); seen.push(params);
      const page = Number(params.page);
      return { status: 200, body: { code: 0, message: 'OK', data: {
        list: [{ dimensions: { campaign_id: 'c' + page }, metrics: { likes: String(page), comments: '0', shares: '0', profile_visits: '0' } }],
        page_info: { page, page_size: 1000, total_page: 2, total_number: 2 },
      } } };
    }
    return { status: 404, body: {} };
  });
  const rows = await c.fetchAdReport('adv1', '2026-08');
  assert.equal(rows.length, 2, 'both pages fetched');
  assert.deepEqual(rows.map((r) => r.dimensions.campaign_id), ['c1', 'c2']);
  assert.equal(seen[0].data_level, 'AUCTION_CAMPAIGN');
  assert.equal(seen[0].dimensions, JSON.stringify(['campaign_id']));
  assert.equal(seen[0].metrics, JSON.stringify(['likes', 'comments', 'shares', 'profile_visits']));
  assert.equal(seen[0].start_date, '2026-08-01');
  assert.equal(seen[0].end_date, '2026-08-31');
  assert.equal(seen[0].page, '1'); assert.equal(seen[1].page, '2');
});

test('fetchAdReport throws TT_ERROR when the report returns code !== 0', async () => {
  const c = clientWith(() => ({ status: 200, body: { code: 40002, message: 'bad report' } }));
  await assert.rejects(() => c.fetchAdReport('adv', '2026-08'), (e) => e.code === 'TT_ERROR' && /bad report/.test(e.message));
});

// --- GMV Max store discovery: the own shop is invisible to store/list -------------------
// Verified live 2026-09-22 against Lilsheep's advertiser 7171694561926987777:
// gmv_max/store/list returned 9 stores, EVERY one of them another client's shop with
// is_gmv_max_available=false, and Lilsheep's own shop absent entirely — while
// gmv_max/report/get with that shop's own id returned 71 campaigns, B32,239 spend and
// B108,584 revenue. Filtering the list alone therefore yields [], so syncGmvMax skips the
// advertiser and the dashboard shows nothing while GMV Max is in fact running.

test("getGmvMaxStores includes the client's own shop, which store/list never returns", async () => {
  const c = clientWith((p) => {
    if (p === '/clients/') return { status: 200, body: [{ id: 'cid1' }] };
    if (p === '/gateway/ads/gmv_max/store/list/') {
      return { status: 200, body: { code: 0, data: { store_list: [
        { store_id: '7494197474403452699', store_name: 'Charizee', is_gmv_max_available: false },
      ] } } };
    }
    if (p === '/gateway/shop/cid1/authorization/202309/shops') {
      return { status: 200, body: { code: 0, data: { shops: [
        { id: '7494703669286898633', code: 'THLCJ8WLTT', name: 'lilsheepcafe' },
      ] } } };
    }
    return { status: 404, body: {} };
  });
  const stores = await c.getGmvMaxStores('7171694561926987777');
  assert.deepEqual(stores.map((s) => s.store_id), ['7494703669286898633']);
});

test('getGmvMaxStores does not list the own shop twice when store/list also grants it', async () => {
  const c = clientWith((p) => {
    if (p === '/clients/') return { status: 200, body: [{ id: 'cid1' }] };
    if (p === '/gateway/ads/gmv_max/store/list/') {
      return { status: 200, body: { code: 0, data: { store_list: [
        { store_id: '777', store_name: 'own', is_gmv_max_available: true },
      ] } } };
    }
    if (p === '/gateway/shop/cid1/authorization/202309/shops') {
      return { status: 200, body: { code: 0, data: { shops: [{ id: '777', name: 'own' }] } } };
    }
    return { status: 404, body: {} };
  });
  assert.deepEqual((await c.getGmvMaxStores('adv')).map((s) => s.store_id), ['777']);
});

test('getGmvMaxStores still returns granted stores when the client has no shop connected', async () => {
  // A non-shop client must not lose the stores it WAS granted just because the shop
  // lookup 400s — the own-shop probe is additive, never a precondition.
  const c = clientWith((p) => {
    if (p === '/clients/') return { status: 200, body: [{ id: 'cid1' }] };
    if (p === '/gateway/ads/gmv_max/store/list/') {
      return { status: 200, body: { code: 0, data: { store_list: [
        { store_id: 'granted1', is_gmv_max_available: true },
      ] } } };
    }
    if (p === '/gateway/shop/cid1/authorization/202309/shops') {
      return { status: 400, body: { detail: 'ลูกค้ารายนี้ยังไม่ได้เชื่อม TikTok Shop' } };
    }
    return { status: 404, body: {} };
  });
  assert.deepEqual((await c.getGmvMaxStores('adv')).map((s) => s.store_id), ['granted1']);
});

test('getGmvMaxStores does not fail silently when the shop lookup returns code != 0', async () => {
  // A revoked/expired shop token arrives as HTTP 200 with code != 0. Swallowing it would
  // reproduce the exact bug this probe exists to fix — GMV Max quietly missing — so it has to
  // leave a trace even though returning the granted list is still the right answer.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const c = clientWith((p) => {
      if (p === '/clients/') return { status: 200, body: [{ id: 'cid1' }] };
      if (p === '/gateway/ads/gmv_max/store/list/') {
        return { status: 200, body: { code: 0, data: { store_list: [{ store_id: 'granted1', is_gmv_max_available: true }] } } };
      }
      if (p === '/gateway/shop/cid1/authorization/202309/shops') {
        return { status: 200, body: { code: 105002, message: 'shop token expired', data: null } };
      }
      return { status: 404, body: {} };
    });
    assert.deepEqual((await c.getGmvMaxStores('adv')).map((s) => s.store_id), ['granted1']);
    assert.ok(warnings.some((w) => /105002|shop token expired/.test(w)), 'the failure was logged');
  } finally { console.warn = realWarn; }
});

test('getGmvMaxStores keeps the own shop even when store/list reports it unavailable', async () => {
  // TikTok marks a store unavailable when it is bound to a DIFFERENT advertiser. For the
  // client's own shop that verdict is about someone else's binding, not ours — verified live:
  // report/get returned real campaigns for a shop the list had never mentioned.
  const c = clientWith((p) => {
    if (p === '/clients/') return { status: 200, body: [{ id: 'cid1' }] };
    if (p === '/gateway/ads/gmv_max/store/list/') {
      return { status: 200, body: { code: 0, data: { store_list: [
        { store_id: '7494703669286898633', store_name: 'lilsheepcafe', is_gmv_max_available: false },
      ] } } };
    }
    if (p === '/gateway/shop/cid1/authorization/202309/shops') {
      return { status: 200, body: { code: 0, data: { shops: [{ id: '7494703669286898633', name: 'lilsheepcafe' }] } } };
    }
    return { status: 404, body: {} };
  });
  const stores = await c.getGmvMaxStores('adv');
  assert.deepEqual(stores.map((s) => s.store_id), ['7494703669286898633']);
  assert.equal(stores[0].source, 'own_shop');
});

// ---- shop_products/performance: per-product sales, all channels (what Seller Center shows) ----

test('readShopProduct reads the flat shape (gmv.amount, sku_orders, items_sold, name)', () => {
  assert.deepEqual(
    readShopProduct({ id: 'p1', name: 'Sleep  Well', gmv: { amount: '30000.50', currency: 'THB' }, sku_orders: '300', items_sold: 410 }),
    { id: 'p1', name: 'Sleep Well', gmv: 30000.5, orders: 300, items_sold: 410 });
});

test('readShopProduct reads the nested sales.overall shape and the title/product_id aliases', () => {
  assert.deepEqual(
    readShopProduct({ product_id: 7, title: 'Lion mane', sales: { overall: { gmv: { amount: '9000' }, orders: 90, units_sold: 120 } } }),
    { id: '7', name: 'Lion mane', gmv: 9000, orders: 90, items_sold: 120 });
});

test('readShopProduct keeps gmv null (not 0) when nothing parses, and returns null without an id', () => {
  assert.equal(readShopProduct({ id: 'p1', name: 'x' }).gmv, null);
  assert.equal(readShopProduct({ name: 'no id', gmv: { amount: '5' } }), null);
  assert.equal(readShopProduct({ id: 'p1', gmv: { amount: '0' } }).gmv, 0, 'a real zero is still a number');
});

const PRODUCTS_PATH = (v) => `/gateway/shop/c1/analytics/${v}/shop_products/performance`;
const okPage = (shop_products, next_page_token = '') => ({ status: 200, body: { code: 0, data: { shop_products, next_page_token } } });
const flat = (id, gmv) => ({ id, name: 'P' + id, gmv: { amount: String(gmv) }, sku_orders: 1, items_sold: 1 });

test('fetchShopProducts sends the exclusive month range, sorts by gmv and follows next_page_token', async () => {
  const seen = [];
  const c = clientWith((p, q) => {
    if (p === PRODUCTS_PATH('202509')) {
      seen.push(Object.fromEntries(q));
      return q.get('page_token') ? okPage([flat('2', 50)]) : okPage([flat('1', 100)], 'tok2');
    }
    return { status: 404, body: {} };
  });
  const out = await c.fetchShopProducts('c1', '2026-09');
  assert.equal(out.version, '202509');
  assert.equal(out.truncated, false);
  assert.deepEqual(out.products.map((p) => p.id), ['1', '2']);
  assert.equal(seen[0].start_date_ge, '2026-09-01');
  assert.equal(seen[0].end_date_lt, '2026-10-01');
  assert.equal(seen[0].sort_field, 'gmv');
  assert.equal(seen[0].sort_order, 'DESC');
  assert.equal(seen[0].currency, 'LOCAL');
  assert.equal(seen[1].page_token, 'tok2');
});

test('fetchShopProducts falls back to 202405 when 202509 refuses, and remembers the version that worked', async () => {
  const hits = [];
  const c = clientWith((p) => {
    hits.push(p);
    if (p === PRODUCTS_PATH('202509')) return { status: 200, body: { code: 36009004, message: 'path not found' } };
    if (p === PRODUCTS_PATH('202405')) return okPage([flat('1', 100)]);
    return { status: 404, body: {} };
  });
  const first = await c.fetchShopProducts('c1', '2026-09');
  assert.equal(first.version, '202405');
  assert.deepEqual(hits, [PRODUCTS_PATH('202509'), PRODUCTS_PATH('202405')]);
  hits.length = 0;
  await c.fetchShopProducts('c1', '2026-08');
  assert.deepEqual(hits, [PRODUCTS_PATH('202405')], 'the dead version is not retried for later months');
});

test('the 180-day lookback wall is thrown at once, not retried on the other version', async () => {
  const hits = [];
  const c = clientWith((p) => { hits.push(p); return { status: 200, body: { code: TIKTOK_OUTSIDE_LOOKBACK, message: 'outside the lookback window' } }; });
  await assert.rejects(() => c.fetchShopProducts('c1', '2026-01'), (e) => e.ttCode === TIKTOK_OUTSIDE_LOOKBACK);
  assert.equal(hits.length, 1);
});

test('an auth failure is thrown at once too — it is not a version problem', async () => {
  const hits = [];
  const c = clientWith((p) => { hits.push(p); return { status: 401, body: { detail: 'nope' } }; });
  await assert.rejects(() => c.fetchShopProducts('c1', '2026-09'), (e) => e.code === 'RP_AUTH');
  assert.equal(hits.length, 1);
});

test('when both versions fail the error names BOTH reasons', async () => {
  const c = clientWith((p) => ({ status: 200, body: { code: 40001, message: 'reason for ' + p.split('/')[5] } }));
  await assert.rejects(() => c.fetchShopProducts('c1', '2026-09'), (e) =>
    /202509: reason for 202509/.test(e.message) && /202405: reason for 202405/.test(e.message));
});

test('rows with no readable gmv are refused loudly, naming the fields seen, instead of stored as zeros', async () => {
  const c = clientWith(() => okPage([{ id: '1', weird: { shape: 1 } }, { id: '2', weird: {} }]));
  await assert.rejects(() => c.fetchShopProducts('c1', '2026-09'), (e) =>
    /อ่านยอดขาย/.test(e.message) && /id, weird/.test(e.message) && /202509/.test(e.message) && /202405/.test(e.message));
});

test('an empty product list is a normal empty result, not an error', async () => {
  const c = clientWith(() => okPage([]));
  const out = await c.fetchShopProducts('c1', '2026-09');
  assert.deepEqual(out.products, []);
});

test('a list still paging at maxPages is reported as truncated', async () => {
  const c = clientWith((p, q) => okPage([flat(String(q.get('page_token') || 'a'), 1)], 'more'));
  const out = await c.fetchShopProducts('c1', '2026-09', { maxPages: 2 });
  assert.equal(out.truncated, true);
  assert.equal(out.products.length, 2);
});

// ---- product pictures: Get Product -> main_images ----

test('readProductImageUrl prefers a thumbnail, falls back to the full url, and refuses non-https', () => {
  assert.equal(readProductImageUrl({ main_images: [{ urls: ['https://cdn/full.jpg'], thumb_urls: ['https://cdn/thumb.jpg'] }] }), 'https://cdn/thumb.jpg');
  assert.equal(readProductImageUrl({ main_images: [{ urls: ['https://cdn/full.jpg'] }] }), 'https://cdn/full.jpg');
  assert.equal(readProductImageUrl({ main_images: [{ thumb_urls: ['http://insecure/a.jpg'], urls: ['https://cdn/ok.jpg'] }] }), 'https://cdn/ok.jpg');
  assert.equal(readProductImageUrl({ main_images: [{ urls: ['http://insecure/a.jpg'] }] }), '');
});

test('readProductImageUrl reads the nested/alias shapes and returns "" when there is no picture', () => {
  assert.equal(readProductImageUrl({ product: { main_images: [{ urls: ['https://cdn/n.jpg'] }] } }), 'https://cdn/n.jpg');
  assert.equal(readProductImageUrl({ images: [{ urls: ['https://cdn/i.jpg'] }] }), 'https://cdn/i.jpg');
  for (const bad of [{}, null, undefined, { main_images: [] }, { main_images: 'x' }, { main_images: [null, {}] }]) assert.equal(readProductImageUrl(bad), '');
});

const DETAIL_PATH = (v, id = '123') => `/gateway/shop/c1/product/${v}/products/${id}`;

test('fetchProductImage asks Get Product for one id and returns the picture url', async () => {
  const hits = [];
  const c = clientWith((p) => { hits.push(p); return p === DETAIL_PATH('202309') ? { status: 200, body: { code: 0, data: { main_images: [{ thumb_urls: ['https://cdn/t.jpg'] }] } } } : { status: 404, body: {} }; });
  const out = await c.fetchProductImage('c1', '123');
  assert.deepEqual(out, { url: 'https://cdn/t.jpg', version: '202309' });
  assert.deepEqual(hits, [DETAIL_PATH('202309')]);
});

test('a product with no picture is a normal empty result, not an error', async () => {
  const c = clientWith(() => ({ status: 200, body: { code: 0, data: { id: '123', title: 'x' } } }));
  assert.deepEqual(await c.fetchProductImage('c1', '123'), { url: '', version: '202309' });
});

test('fetchProductImage falls back to 202212 and then remembers it', async () => {
  const hits = [];
  const c = clientWith((p) => {
    hits.push(p);
    if (p === DETAIL_PATH('202309', '1')) return { status: 200, body: { code: 36009004, message: 'no such path' } };
    return { status: 200, body: { code: 0, data: { main_images: [{ urls: ['https://cdn/a.jpg'] }] } } };
  });
  assert.equal((await c.fetchProductImage('c1', '1')).version, '202212');
  hits.length = 0;
  await c.fetchProductImage('c1', '2');
  assert.deepEqual(hits, [DETAIL_PATH('202212', '2')]);
});

test('fetchProductImage refuses a non-numeric id before it can reach the URL path', async () => {
  const hits = [];
  const c = clientWith((p) => { hits.push(p); return { status: 200, body: { code: 0, data: {} } }; });
  for (const bad of ['../../etc', '12/34', '', 'abc', '1 2']) await assert.rejects(() => c.fetchProductImage('c1', bad), (e) => e.code === 'BAD_PRODUCT');
  assert.equal(hits.length, 0);
});

test('fetchProductImage throws at once on auth / quota instead of trying the other version', async () => {
  const hits = [];
  const c = clientWith((p) => { hits.push(p); return { status: 401, body: {} }; });
  await assert.rejects(() => c.fetchProductImage('c1', '123'), (e) => e.code === 'RP_AUTH');
  assert.equal(hits.length, 1);
});
