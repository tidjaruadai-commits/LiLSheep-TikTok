import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportPilotClient } from '../connectors/report-pilot.js';

// routes: (path, searchParams) => { status, body }
function clientWith(routes) {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const r = routes(u.pathname, u.searchParams);
    return { status: r.status, async json() { return r.body; }, async text() { return JSON.stringify(r.body); } };
  };
  return createReportPilotClient({ base: 'https://api.tidjaruad.co', getKey: () => 'rpt_' + 'a'.repeat(24), fetchImpl });
}

test('fetchShopVideos hits the shop_videos list with the exclusive month range + LOCAL currency and returns data.videos', async () => {
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/gateway/shop/uuid-1/analytics/202509/shop_videos/performance') {
      seen = Object.fromEntries(q);
      return { status: 200, body: { code: 0, data: { videos: [{ id: '1' }, { id: '2' }], total_count: 2, next_page_token: '' } } };
    }
    return { status: 404, body: {} };
  });
  const videos = await c.fetchShopVideos('uuid-1', '2026-08');
  assert.deepEqual(videos.map((v) => v.id), ['1', '2']);
  assert.equal(seen.start_date_ge, '2026-08-01');
  assert.equal(seen.end_date_lt, '2026-09-01');    // EXCLUSIVE end (same as shop-metrics)
  assert.equal(seen.currency, 'LOCAL');
  assert.equal(seen.account_type, 'ALL');
  assert.equal(seen.sort_field, 'gmv');
  assert.equal(seen.sort_order, 'DESC');
});

test('fetchShopVideos follows next_page_token up to maxPages and concatenates the pages', async () => {
  const pages = {
    '': { videos: [{ id: '1' }], next_page_token: 'tok2' },
    tok2: { videos: [{ id: '2' }], next_page_token: 'tok3' },
    tok3: { videos: [{ id: '3' }], next_page_token: '' },
  };
  const seenTokens = [];
  const c = clientWith((p, q) => {
    if (p.endsWith('/shop_videos/performance')) {
      const tok = q.get('page_token') || '';
      seenTokens.push(tok);
      return { status: 200, body: { code: 0, data: pages[tok] } };
    }
    return { status: 404, body: {} };
  });
  const videos = await c.fetchShopVideos('uuid-1', '2026-08', { maxPages: 2 });
  assert.deepEqual(videos.map((v) => v.id), ['1', '2']);   // stopped at maxPages=2, never fetched tok3
  assert.deepEqual(seenTokens, ['', 'tok2']);
});

test('fetchShopVideos throws TT_ERROR when TikTok returns a non-zero code', async () => {
  const c = clientWith(() => ({ status: 200, body: { code: 12345678, message: 'shop not authorized' } }));
  await assert.rejects(() => c.fetchShopVideos('uuid-1', '2026-08'), (e) => e.code === 'TT_ERROR' && /shop not authorized/.test(e.message));
});

test('fetchGmvMaxItems chains campaign -> item_group -> item_id and returns per-clip rows (drops the "-1" LIVE bucket)', async () => {
  const seen = {};
  const c = clientWith((p, q) => {
    if (p !== '/gateway/ads/gmv_max/report/get/') return { status: 404, body: {} };
    const dims = JSON.parse(q.get('dimensions'));
    if (dims[0] === 'campaign_id') {
      return { status: 200, body: { code: 0, data: { list: [{ dimensions: { campaign_id: 'c1' } }, { dimensions: { campaign_id: 'c2' } }] } } };
    }
    if (dims[0] === 'item_group_id') {
      seen.groupFiltering = q.get('filtering');
      return { status: 200, body: { code: 0, data: { list: [{ dimensions: { item_group_id: 'g1' } }] } } };
    }
    if (dims[0] === 'item_id') {
      seen.itemParams = Object.fromEntries(q);
      return { status: 200, body: { code: 0, data: { list: [
        { dimensions: { item_id: '7574043265901595922' }, metrics: { cost: '127164.86', gross_revenue: '416702.20', roi: '3.28', orders: '1324' } },
        { dimensions: { item_id: '-1' }, metrics: { cost: '80000', gross_revenue: '160000', roi: '2', orders: '400' } },
      ] } } };
    }
    return { status: 404, body: {} };
  });
  const items = await c.fetchGmvMaxItems('7218524808659615746', '7494836523330930707', '2026-08');
  assert.equal(items.length, 1);                       // the "-1" LIVE sentinel is dropped
  assert.equal(items[0].item_id, '7574043265901595922');
  assert.equal(items[0].cost, '127164.86');
  assert.equal(items[0].gross_revenue, '416702.20');
  assert.equal(items[0].orders, '1324');
  // the item-level call carries the campaign + item_group filter and asks TikTok to sort by cost desc
  assert.deepEqual(JSON.parse(seen.itemParams.filtering), { campaign_ids: ['c1', 'c2'], item_group_ids: ['g1'] });
  assert.equal(seen.itemParams.sort_field, 'cost');
  assert.equal(seen.itemParams.sort_type, 'DESC');
  assert.deepEqual(JSON.parse(seen.groupFiltering), { campaign_ids: ['c1', 'c2'] });
});

test('fetchGmvMaxItems returns [] without an item call when there are no GMV Max campaigns', async () => {
  let itemCalled = false;
  const c = clientWith((p, q) => {
    if (p !== '/gateway/ads/gmv_max/report/get/') return { status: 404, body: {} };
    const dims = JSON.parse(q.get('dimensions'));
    if (dims[0] === 'campaign_id') return { status: 200, body: { code: 0, data: { list: [] } } };
    if (dims[0] === 'item_id') itemCalled = true;
    return { status: 200, body: { code: 0, data: { list: [] } } };
  });
  const items = await c.fetchGmvMaxItems('adv', 'store', '2026-08');
  assert.deepEqual(items, []);
  assert.equal(itemCalled, false);
});

test('fetchShopVideoDetail sums the interval traffic into per-clip engagement (ALL granularity)', async () => {
  let seen;
  const c = clientWith((p, q) => {
    if (p === '/gateway/shop/uuid-1/analytics/202509/shop_videos/7574043265901595922/performance') {
      seen = Object.fromEntries(q);
      return { status: 200, body: { code: 0, data: { performance: { intervals: [
        { traffic: { views: '703958', likes: '4280', comments: '42', shares: '1700', new_followers: '196' } },
      ] } } } };
    }
    return { status: 404, body: {} };
  });
  const d = await c.fetchShopVideoDetail('uuid-1', '7574043265901595922', '2026-08');
  assert.deepEqual(d, { views: 703958, likes: 4280, comments: 42, shares: 1700, new_followers: 196 });
  assert.equal(seen.granularity, 'ALL');
  assert.equal(seen.start_date_ge, '2026-08-01');
  assert.equal(seen.end_date_lt, '2026-09-01');
});

test('fetchShopVideoDetail retries after a rate-limit error (backing off via the injected sleep) then succeeds', async () => {
  let attempts = 0, slept = 0;
  const c = clientWith((p) => {
    if (p.endsWith('/performance')) {
      attempts++;
      if (attempts === 1) return { status: 429, body: { code: 40100, message: 'Too many requests' } };
      return { status: 200, body: { code: 0, data: { performance: { intervals: [{ traffic: { views: '1', likes: '1', comments: '0', shares: '0', new_followers: '0' } }] } } } };
    }
    return { status: 404, body: {} };
  });
  const d = await c.fetchShopVideoDetail('uuid-1', 'vid', '2026-08', { retries: 2, backoffMs: 1, sleep: async () => { slept++; } });
  assert.equal(attempts, 2);
  assert.equal(slept, 1);
  assert.equal(d.views, 1);
});

test('fetchShopVideoDetail does NOT back off on the app-wide quota (36009002) — it never recovers inside a run', async () => {
  // Measured: a 10 s backoff still failed 9 tries out of 10, and a single isolated call was
  // refused a day later. Sleeping on it only spends the serverless budget, ~10 s per clip, on
  // a quota shared with every other client of the app.
  let attempts = 0, slept = 0;
  const c = clientWith((p) => {
    if (p.endsWith('/performance')) {
      attempts++;
      return { status: 429, body: { code: 36009002, message: 'Too many requests. This app has exceeded a shared app-group rate limit.' } };
    }
    return { status: 404, body: {} };
  });
  await assert.rejects(
    () => c.fetchShopVideoDetail('uuid-1', 'vid', '2026-08', { retries: 2, backoffMs: 10000, sleep: async () => { slept++; } }),
    /shared app-group rate limit/,
  );
  assert.equal(attempts, 1, 'one attempt, then give up on this clip');
  assert.equal(slept, 0, 'no backoff spent waiting for a quota that does not reset within the run');
});

test('the app-wide quota is recognised when TikTok reports it as HTTP 200 with a non-zero code too', async () => {
  let attempts = 0, slept = 0;
  const c = clientWith((p) => {
    if (p.endsWith('/performance')) {
      attempts++;
      return { status: 200, body: { code: 36009002, message: 'Too many requests. This app has exceeded a shared app-group rate limit.' } };
    }
    return { status: 404, body: {} };
  });
  await assert.rejects(
    () => c.fetchShopVideoDetail('uuid-1', 'vid', '2026-08', { retries: 2, backoffMs: 10000, sleep: async () => { slept++; } }),
    /shared app-group rate limit/,
  );
  assert.equal(attempts, 1);
  assert.equal(slept, 0);
});
