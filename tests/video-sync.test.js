import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapShopVideos, mergeAdItems, mergeEngagement, keepEngagement, keepCovers, clipUrl, fetchOembedThumbnail, syncVideos } from '../lib/video-sync.js';

// Real August 2026 rows from the live shop_videos list (values arrive as STRINGS from TikTok).
const rawVideos = [
  { id: '7574043265901595922', title: 'กัมมี่ หมีหลับ', username: 'nutthanon_loetphatphicha',
    video_post_time: '2026-08-03 10:00:00', products: [{ id: 'p1', name: 'Lilsheep หมีหลับ' }],
    gmv: { amount: '382687.69', currency: 'THB' }, gpm: { amount: '543.61' },
    sku_orders: '1337', items_sold: '1350', views: '703958', click_through_rate: '0.0221' },
  { id: '7642362725158440210', title: 'crazymuscle', username: 'crazymuscleth',
    video_post_time: '2026-08-10 12:00:00', products: [{ id: 'p2', name: 'Whey' }],
    gmv: { amount: '218989.04', currency: 'THB' }, gpm: { amount: '206.8' },
    sku_orders: '770', items_sold: '778', views: '1059148', click_through_rate: '0.0170' },
];

test('mapShopVideos projects shop_videos rows, coercing TikTok string values to numbers', () => {
  const rows = mapShopVideos('2026-08', rawVideos);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    month: '2026-08', video_id: '7574043265901595922', title: 'กัมมี่ หมีหลับ',
    username: 'nutthanon_loetphatphicha', product: 'Lilsheep หมีหลับ', post_time: '2026-08-03 10:00:00',
    gmv: 382687.69, orders: 1337, items_sold: 1350, views: 703958, ctr: 0.0221, gpm: 543.61,
  });
});

test('mapShopVideos dedupes by video_id (keeps first) and skips rows with no id', () => {
  const rows = mapShopVideos('2026-08', [
    { id: '1', title: 'a', gmv: { amount: '10' }, views: '5' },
    { id: '1', title: 'dup', gmv: { amount: '99' }, views: '9' },
    { title: 'no id', gmv: { amount: '1' } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'a');
});

test('mergeAdItems attaches GMV-Max per-clip cost/revenue/orders by item_id and RECOMPUTES roi from totals', () => {
  const videoRows = mapShopVideos('2026-08', rawVideos);
  const adItems = [
    { item_id: '7574043265901595922', cost: '127164.86', gross_revenue: '416702.20', orders: '1324' },
  ];
  const merged = mergeAdItems('2026-08', videoRows, adItems);
  const hit = merged.find((r) => r.video_id === '7574043265901595922');
  assert.equal(hit.ad_cost, 127164.86);
  assert.equal(hit.ad_gross_revenue, 416702.2);
  assert.equal(hit.ad_orders, 1324);
  assert.equal(hit.ad_roi, 3.28);                       // round2(416702.2 / 127164.86), never the TikTok roi string
  // a video that got no ad spend keeps ad_* null (it is not a GMV Max item)
  const noAd = merged.find((r) => r.video_id === '7642362725158440210');
  assert.equal(noAd.ad_cost, null);
  assert.equal(noAd.ad_roi, null);
});

test('mergeAdItems adds an ad-only row (title unknown) for a GMV Max item that is not in the shop-video top list', () => {
  const merged = mergeAdItems('2026-08', [], [{ item_id: '9999', cost: '1000', gross_revenue: '5000', orders: '20' }]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    month: '2026-08', video_id: '9999', title: '', username: '', product: '', post_time: '',
    gmv: 0, orders: 0, items_sold: 0, views: 0, ctr: 0, gpm: 0,
    ad_cost: 1000, ad_gross_revenue: 5000, ad_orders: 20, ad_roi: 5,
  });
});

test('mergeAdItems skips the LIVE sentinel item_id "-1" (LIVE GMV Max has no per-clip breakdown)', () => {
  const merged = mergeAdItems('2026-08', [], [{ item_id: '-1', cost: '999', gross_revenue: '999', orders: '9' }]);
  assert.deepEqual(merged, []);
});

test('mergeAdItems SUMS duplicate item_id across advertisers/stores and recomputes roi from the summed totals', () => {
  const merged = mergeAdItems('2026-08', [], [
    { item_id: 'v1', cost: '100', gross_revenue: '300', orders: '3' },
    { item_id: 'v1', cost: '100', gross_revenue: '100', orders: '2' },   // same clip, second account/store
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].ad_cost, 200);            // summed, not overwritten
  assert.equal(merged[0].ad_gross_revenue, 400);
  assert.equal(merged[0].ad_orders, 5);
  assert.equal(merged[0].ad_roi, 2);               // round2(400/200), never the last slice's 1.0
});

test('mergeEngagement attaches per-clip likes/comments/shares/new_followers from the detail endpoint', () => {
  const videoRows = mapShopVideos('2026-08', rawVideos);
  const merged = mergeEngagement(videoRows, {
    '7574043265901595922': { views: 703958, likes: 4280, comments: 42, shares: 1700, new_followers: 196 },
  });
  const hit = merged.find((r) => r.video_id === '7574043265901595922');
  assert.equal(hit.likes, 4280);
  assert.equal(hit.comments, 42);
  assert.equal(hit.shares, 1700);
  assert.equal(hit.new_followers, 196);
  // a clip with no detail fetched leaves engagement null (so the dashboard can tell "0" from "not measured")
  const noDetail = merged.find((r) => r.video_id === '7642362725158440210');
  assert.equal(noDetail.likes, null);
});

test('keepEngagement preserves previously-measured engagement for clips this run did not re-fetch (rate limit means only a few clips get details per run)', () => {
  const rows = [
    { video_id: 'v1', likes: 100, comments: 1, shares: 2, new_followers: 3 },       // measured THIS run
    { video_id: 'v2', likes: null, comments: null, shares: null, new_followers: null }, // not measured this run
    { video_id: 'v3', likes: null, comments: null, shares: null, new_followers: null }, // never measured
  ];
  const existing = [{ video_id: 'v2', likes: 50, comments: 5, shares: 6, new_followers: 7 }];
  const merged = keepEngagement(rows, existing);
  assert.equal(merged.find((r) => r.video_id === 'v1').likes, 100);   // fresh measurement is kept
  const v2 = merged.find((r) => r.video_id === 'v2');
  assert.deepEqual([v2.likes, v2.comments, v2.shares, v2.new_followers], [50, 5, 6, 7]);   // recovered from DB
  assert.equal(merged.find((r) => r.video_id === 'v3').likes, null);  // still unmeasured
});

test('clipUrl builds the TikTok video URL, empty when username or id is missing', () => {
  assert.equal(clipUrl('nutthanon', '7574'), 'https://www.tiktok.com/@nutthanon/video/7574');
  assert.equal(clipUrl('', '7574'), '');
  assert.equal(clipUrl('u', ''), '');
});

test('fetchOembedThumbnail returns the https thumbnail_url and null on any failure (best-effort)', async () => {
  const ok = async () => ({ status: 200, async json() { return { thumbnail_url: 'https://cdn/x.jpg', title: 't' }; } });
  assert.equal(await fetchOembedThumbnail('nutthanon', '123', ok), 'https://cdn/x.jpg');
  assert.equal(await fetchOembedThumbnail('u', '1', async () => ({ status: 500, async json() { return {}; } })), null);
  assert.equal(await fetchOembedThumbnail('u', '1', async () => ({ status: 200, async json() { return { title: 't' }; } })), null);   // no thumbnail
  assert.equal(await fetchOembedThumbnail('u', '1', async () => { throw new Error('network'); }), null);   // never throws
  assert.equal(await fetchOembedThumbnail('', '', ok), null);   // no username/id -> no call
});

test('fetchOembedThumbnail requests the oembed endpoint for the clip URL', async () => {
  let seen; const f = async (u) => { seen = u; return { status: 200, async json() { return { thumbnail_url: 'https://c/x' }; } }; };
  await fetchOembedThumbnail('nutthanon_x', '7574', f);
  assert.match(seen, /tiktok\.com\/oembed\?url=https%3A%2F%2Fwww\.tiktok\.com%2F%40nutthanon_x%2Fvideo%2F7574/);
});

test('keepCovers preserves a stored cover_url when this run did not fetch one, and normalizes missing to null', () => {
  const rows = [{ video_id: 'v1', cover_url: 'https://new/a' }, { video_id: 'v2' }, { video_id: 'v3' }];
  const existing = [{ video_id: 'v2', cover_url: 'https://old/b' }];
  const m = keepCovers(rows, existing);
  assert.equal(m.find((r) => r.video_id === 'v1').cover_url, 'https://new/a');   // fresh kept
  assert.equal(m.find((r) => r.video_id === 'v2').cover_url, 'https://old/b');   // recovered from DB
  assert.equal(m.find((r) => r.video_id === 'v3').cover_url, null);              // none anywhere
});

// --- syncVideos orchestrator (I/O, isolation) ---
const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };

function makeClient(overrides = {}) {
  return {
    fetchShopVideos: async () => rawVideos,
    getGmvMaxStores: async () => [{ store_id: 's1', is_gmv_max_available: true }],
    fetchGmvMaxItems: async () => [{ item_id: '7574043265901595922', cost: '127164.86', gross_revenue: '416702.20', orders: '1324' }],
    fetchShopVideoDetail: async () => ({ views: 703958, likes: 4280, comments: 42, shares: 1700, new_followers: 196 }),
    ...overrides,
  };
}

test('syncVideos fetches shop videos, joins GMV Max per-clip ads + engagement, and upserts m039_video_monthly', async () => {
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method, body: opts.body }); return { status: 201, async text() { return '[]'; }, async json() { return []; } }; };
  const res = await syncVideos({ cfg, client: makeClient(), clientId: 'uuid-1', advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch, detailTopN: 2, sleep: async () => {} });
  assert.equal(res.ok, true);
  const post = writes.find((w) => w.url.includes('/m039_video_monthly') && w.method === 'POST');
  assert.ok(post, 'upserted m039_video_monthly');
  assert.match(post.url, /on_conflict=month,video_id/);
  const rows = JSON.parse(post.body);
  const hit = rows.find((r) => r.video_id === '7574043265901595922');
  assert.equal(hit.ad_cost, 127164.86);
  assert.equal(hit.likes, 4280);
});

test('syncVideos fetches oembed covers for the top clips and stores cover_url', async () => {
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method, body: opts.body }); return { status: 201, async text() { return '[]'; }, async json() { return []; } }; };
  const fetchCover = async (username, videoId) => `https://cdn/${videoId}.jpg`;
  await syncVideos({ cfg, client: makeClient(), clientId: 'uuid-1', advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch, detailTopN: 2, fetchCover, sleep: async () => {} });
  const post = writes.find((w) => w.url.includes('/m039_video_monthly') && w.method === 'POST');
  const row = JSON.parse(post.body).find((r) => r.video_id === '7574043265901595922');
  assert.equal(row.cover_url, 'https://cdn/7574043265901595922.jpg');
});

test('syncVideos isolates a failed engagement-detail fetch: the core clip rows still upsert', async () => {
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method, body: opts.body }); return { status: 201, async text() { return '[]'; }, async json() { return []; } }; };
  const client = makeClient({ fetchShopVideoDetail: async () => { throw new Error('Too many requests'); } });
  const res = await syncVideos({ cfg, client, clientId: 'uuid-1', advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch, detailTopN: 2, sleep: async () => {} });
  const post = writes.find((w) => w.url.includes('/m039_video_monthly') && w.method === 'POST');
  assert.ok(post, 'core clip rows upserted even though every detail fetch failed');
  const rows = JSON.parse(post.body);
  assert.equal(rows.find((r) => r.video_id === '7574043265901595922').ad_cost, 127164.86);
  assert.equal(rows.find((r) => r.video_id === '7574043265901595922').likes, null);   // engagement skipped, not fatal
});

test('syncVideos stops fetching engagement details once the detail budget is spent (protects the serverless time budget)', async () => {
  let detailCalls = 0;
  const client = makeClient({ fetchShopVideoDetail: async () => { detailCalls++; return { views: 1, likes: 1, comments: 0, shares: 0, new_followers: 0 }; } });
  const fakeFetch = async () => ({ status: 201, async text() { return '[]'; }, async json() { return []; } });
  let n = 0;
  const now = () => (n++ === 0 ? 0 : 999999);   // budget clock jumps past the limit right after the first detail
  const res = await syncVideos({ cfg, client, clientId: 'uuid-1', advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch, detailTopN: 5, detailBudgetMs: 10, now, sleep: async () => {} });
  assert.equal(res.ok, true);
  assert.equal(detailCalls, 1, 'only the first clip detail is fetched before the budget is spent');
});

test('syncVideos merges stored engagement into the upsert (daily runs accumulate, never wipe, engagement)', async () => {
  const writes = [];
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    if (!opts.method && u.includes('/m039_video_monthly') && u.includes('select=video_id')) {
      return { status: 200, async text() { return JSON.stringify([{ video_id: '7574043265901595922', likes: 9, comments: 8, shares: 7, new_followers: 6 }]); } };
    }
    writes.push({ url: u, method: opts.method, body: opts.body });
    return { status: 201, async text() { return '[]'; } };
  };
  const client = makeClient({ fetchShopVideoDetail: async () => { throw new Error('Too many requests'); } });   // this run measures nothing
  await syncVideos({ cfg, client, clientId: 'uuid-1', advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch, detailTopN: 2, sleep: async () => {} });
  const post = writes.find((w) => w.url.includes('/m039_video_monthly') && w.method === 'POST');
  const row = JSON.parse(post.body).find((r) => r.video_id === '7574043265901595922');
  assert.equal(row.likes, 9, 'engagement measured on an earlier run is recovered, not overwritten with null');
});

test('syncVideos does NOT delete or write the month when shop_videos returns empty (a transient blip must never wipe accumulated engagement)', async () => {
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method }); return { status: 201, async text() { return '[]'; } }; };
  const client = makeClient({ fetchShopVideos: async () => [], getGmvMaxStores: async () => { throw new Error('must not run once the month is skipped'); } });
  const res = await syncVideos({ cfg, client, clientId: 'uuid-1', advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch, detailTopN: 2, sleep: async () => {} });
  assert.equal(res.ok, true);
  assert.ok(!writes.some((w) => w.method === 'DELETE'), 'no destructive delete on an empty response');
  assert.ok(!writes.some((w) => w.method === 'POST' && w.url.includes('/m039_video_monthly')), 'no upsert on an empty response');
  assert.ok(res.results.some((r) => r.month === '2026-08' && r.skipped === 'no-videos'), 'month recorded as skipped, not a silent wipe');
});

test('syncVideos aborts the month (no null-wiping upsert) when the engagement-recovery read fails', async () => {
  const writes = [];
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    if (!opts.method && u.includes('/m039_video_monthly') && u.includes('select=video_id')) return { status: 500, async text() { return 'boom'; } };
    writes.push({ url: u, method: opts.method, body: opts.body });
    return { status: 201, async text() { return '[]'; } };
  };
  const client = makeClient({ fetchShopVideoDetail: async () => { throw new Error('rate limited'); } });   // nothing measured this run
  const res = await syncVideos({ cfg, client, clientId: 'uuid-1', advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch, detailTopN: 2, sleep: async () => {} });
  assert.equal(res.ok, false);
  assert.ok(res.results.some((r) => r.month === '2026-08' && r.error), 'month errored instead of wiping engagement');
  assert.ok(!writes.some((w) => w.method === 'POST' && w.url.includes('/m039_video_monthly')), 'no upsert that would overwrite stored engagement with null');
});

test('syncVideos isolates a failed month (shop-videos fetch throws) without aborting the rest', async () => {
  const client = makeClient({ fetchShopVideos: async (cid, month) => { if (month === '2026-07') throw new Error('gateway stalled'); return rawVideos; } });
  const fakeFetch = async () => ({ status: 201, async text() { return '[]'; }, async json() { return []; } });
  const res = await syncVideos({ cfg, client, clientId: 'uuid-1', advertiserIds: ['adv'], months: ['2026-08', '2026-07'], fetchImpl: fakeFetch, detailTopN: 1, sleep: async () => {} });
  assert.equal(res.ok, false);
  assert.ok(res.results.some((r) => r.month === '2026-08' && r.ok === true));
  assert.ok(res.results.some((r) => r.month === '2026-07' && r.error === 'gateway stalled'));
});

test('syncVideos spends its detail calls on clips it has never measured, not on ones already stored', async () => {
  // TikTok caps the per-clip endpoint with a rate limit shared across the WHOLE app
  // (HTTP 429, code 36009002 "shared app-group rate limit"). Observed on Lilsheep
  // 2026-09-21: 18 failures in 100 seconds, and a single isolated call still refused a
  // day later. keepEngagement already stores what we measure for good, so re-measuring a
  // clip buys nothing and burns quota every other client shares. Measure once, ever.
  const seen = [];
  const client = makeClient({
    fetchShopVideoDetail: async (_clientId, videoId) => {
      seen.push(String(videoId));
      return { views: 1, likes: 1, comments: 0, shares: 0, new_followers: 0 };
    },
  });
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    if (!opts.method && u.includes('/m039_video_monthly') && u.includes('select=video_id')) {
      // the highest-views clip was already measured on an earlier run
      return { status: 200, async text() { return JSON.stringify([
        { video_id: '7642362725158440210', likes: 11, comments: 10, shares: 9, new_followers: 8 },
      ]); } };
    }
    return { status: 201, async text() { return '[]'; }, async json() { return []; } };
  };
  const res = await syncVideos({ cfg, client, clientId: 'uuid-1', advertiserIds: ['adv'], months: ['2026-08'], fetchImpl: fakeFetch, detailTopN: 1, sleep: async () => {} });
  assert.equal(res.ok, true);
  assert.ok(!seen.includes('7642362725158440210'), 'already-measured clip must not be re-measured');
  assert.deepEqual(seen, ['7574043265901595922'], 'the call goes to the clip that has no engagement yet');
});
