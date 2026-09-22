import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCreators, mapAffiliateMonthly, syncAffiliate } from '../lib/affiliate-sync.js';

const videos = [
  { id: 'v1', username: 'nutthanon', gmv: { amount: '100' }, sku_orders: '3', views: '1000' },
  { id: 'v2', username: 'nutthanon', gmv: { amount: '50' }, sku_orders: '1', views: '500' },
  { id: 'v3', username: 'onnie', gmv: { amount: '80' }, sku_orders: '2', views: '800' },
  { id: 'v4', username: '', gmv: { amount: '10' }, sku_orders: '1', views: '100' },   // no username -> skipped
];
const lives = [
  { id: 'l1', username: 'papartor', sales_performance: { gmv: { amount: '265' }, sku_orders: '8' } },
  { id: 'l2', username: 'nutthanon', sales_performance: { gmv: { amount: '20' }, sku_orders: '1' } },
];

test('aggregateCreators groups affiliate videos + lives by username with per-channel gmv/orders/views', () => {
  const rows = aggregateCreators('2026-08', videos, lives);
  const n = rows.find((r) => r.username === 'nutthanon');
  assert.deepEqual([n.videos, n.gmv_video, n.orders_video, n.views_video], [2, 150, 4, 1500]);
  assert.deepEqual([n.lives, n.gmv_live, n.orders_live], [1, 20, 1]);
  assert.equal(n.month, '2026-08');
  const p = rows.find((r) => r.username === 'papartor');
  assert.deepEqual([p.videos, p.gmv_video, p.lives, p.gmv_live, p.orders_live], [0, 0, 1, 265, 8]);
  assert.ok(!rows.some((r) => r.username === ''), 'blank username skipped');
});

test('mapAffiliateMonthly builds the single monthly row (growth + carrying-product counts)', () => {
  const row = mapAffiliateMonthly('2026-08', { gmv_video: 7092935.58, gmv_live: 348525.9, orders_video: 22431, orders_live: 1059, video_count: 34067, live_count: 7901 });
  assert.deepEqual(row, { month: '2026-08', gmv_video: 7092935.58, gmv_live: 348525.9, orders_video: 22431, orders_live: 1059, video_count: 34067, live_count: 7901 });
});

const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
function makeAffClient(over = {}) {
  return {
    fetchShopVideos: async () => videos,
    fetchShopLives: async () => lives,
    fetchShopOverview: async (cid, month, kind) => (kind === 'videos' ? { gmv: 7092935.58, orders: 22431 } : { gmv: 348525.9, orders: 1059 }),
    fetchShopCount: async (cid, month, kind) => (kind === 'videos' ? 34067 : 7901),
    ...over,
  };
}

test('syncAffiliate upserts creator rankings (on_conflict month,username) + the monthly growth row', async () => {
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method, body: opts.body }); return { status: 201, async text() { return '[]'; } }; };
  const res = await syncAffiliate({ cfg, client: makeAffClient(), clientId: 'uuid-1', months: ['2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  const cre = writes.find((w) => w.url.includes('/m039_affiliate_creators') && w.method === 'POST');
  assert.ok(cre, 'creators upserted');
  assert.match(cre.url, /on_conflict=month,username/);
  const mon = writes.find((w) => w.url.includes('/m039_affiliate_monthly') && w.method === 'POST');
  assert.ok(mon, 'monthly row upserted');
  const mrow = JSON.parse(mon.body)[0];
  assert.equal(mrow.gmv_video, 7092935.58);
  assert.equal(mrow.video_count, 34067);
  assert.equal(mrow.live_count, 7901);
});

test('a month past TikTok\'s lookback wall is skipped, not reported as a failure', async () => {
  // Backfilling to January asks for months whose affiliate data TikTok will never serve
  // (~180-day analytics wall, ttCode 28001022). That is a boundary, not something that broke.
  const outside = Object.assign(new Error('Invalid Parameter. Parameter `start_date_ge and end_date_lt` is invalid'), { code: 'TT_ERROR', ttCode: 28001022 });
  const client = makeAffClient({ fetchShopVideos: async () => { throw outside; } });
  const fakeFetch = async () => ({ status: 201, async text() { return '[]'; } });
  const res = await syncAffiliate({ cfg, client, clientId: 'uuid-1', months: ['2026-02'], fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results, [{ month: '2026-02', skipped: 'outside-tiktok-window' }]);
});

test('an ordinary affiliate failure is still an error, not silently skipped', async () => {
  const client = makeAffClient({ fetchShopVideos: async () => { throw new Error('gateway 500'); } });
  const fakeFetch = async () => ({ status: 201, async text() { return '[]'; } });
  const res = await syncAffiliate({ cfg, client, clientId: 'uuid-1', months: ['2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, false);
  assert.equal(res.results[0].error, 'gateway 500');
});

test('syncAffiliate skips a month when both affiliate videos and lives are empty (a blip must not zero the growth row)', async () => {
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method }); return { status: 201, async text() { return '[]'; } }; };
  const client = makeAffClient({ fetchShopVideos: async () => [], fetchShopLives: async () => [], fetchShopOverview: async () => { throw new Error('must not run when the month is skipped'); } });
  const res = await syncAffiliate({ cfg, client, clientId: 'uuid-1', months: ['2026-08'], fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  assert.ok(!writes.some((w) => w.method === 'POST' && w.url.includes('/m039_affiliate_monthly')), 'never overwrites the growth row with zeros on a blip');
  assert.ok(!writes.some((w) => w.method === 'POST' && w.url.includes('/m039_affiliate_creators')));
  assert.ok(res.results.some((r) => r.month === '2026-08' && r.skipped === 'no-affiliate-content'));
});

test('syncAffiliate stale-deletes creators by run timestamp (robust for any username, not a fragile in-list)', async () => {
  const writes = [];
  const fakeFetch = async (url, opts = {}) => { writes.push({ url: String(url), method: opts.method, body: opts.body }); return { status: 201, async text() { return '[]'; } }; };
  await syncAffiliate({ cfg, client: makeAffClient(), clientId: 'uuid-1', months: ['2026-08'], fetchImpl: fakeFetch });
  const del = writes.find((w) => w.method === 'DELETE' && w.url.includes('/m039_affiliate_creators'));
  assert.ok(del, 'stale-delete issued');
  assert.match(del.url, /synced_at=lt\./, 'deletes by run timestamp');
  assert.doesNotMatch(del.url, /username=not\.in/, 'no fragile username in-list quoting');
  const post = writes.find((w) => w.method === 'POST' && w.url.includes('/m039_affiliate_creators'));
  assert.ok(JSON.parse(post.body).every((r) => r.synced_at), 'creators upsert stamps synced_at so the timestamp delete is correct');
});

test('syncAffiliate isolates a failed month without aborting the rest', async () => {
  const client = makeAffClient({ fetchShopVideos: async (cid, month) => { if (month === '2026-07') throw new Error('stalled'); return videos; } });
  const fakeFetch = async () => ({ status: 201, async text() { return '[]'; } });
  const res = await syncAffiliate({ cfg, client, clientId: 'uuid-1', months: ['2026-08', '2026-07'], fetchImpl: fakeFetch });
  assert.equal(res.ok, false);
  assert.ok(res.results.some((r) => r.month === '2026-08' && r.ok === true));
  assert.ok(res.results.some((r) => r.month === '2026-07' && r.error === 'stalled'));
});
