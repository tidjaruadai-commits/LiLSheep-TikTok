import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview, buildShops, buildAds, buildClips, buildGmvMax, buildVideos, buildAffiliate, buildTrend, buildProducts, buildInsights, buildAdChannels } from '../lib/dashboard.js';

const shopMonthly = [
  { shop_key: 'S1', gmv: 1000, refund: 50, orders: 10, units: 12, gmv_live: 400, gmv_video: 500, gmv_product_card: 100, top_products: [{ name: 'A' }], live_sessions: [] },
  { shop_key: 'S2', gmv: 500, refund: 0, orders: 5, units: 5, gmv_live: 0, gmv_video: 500, gmv_product_card: 0 },
];
const shopsMeta = [{ key: 'S1', name: 'Lilsheep Shop' }, { key: 'S2', name: 'Second' }];
const adsMonthly = [
  { campaign_type: 'conversion', result_label: 'Conversions', spend: 300, impressions: 9000, clicks: 300, results: 20, video_views: 1000, gmv_ads: 900 },
  { campaign_type: 'video_view', result_label: 'Video Views', spend: 100, impressions: 5000, clicks: 50, results: 4000, video_views: 4000, gmv_ads: 0, video_6s: 3000, video_15s: 1200, video_completed: 600, likes: 500, comments: 4, shares: 5, profile_visits: 200 },
];
const adsItems = [
  { ad_id: 'a1', ad_name: 'Ad1', spend: 60, gmv: 500, deep_score: 7, advertiser_id: '7218', id: 1, month: '2026-09' },
  { ad_id: 'a2', ad_name: 'Ad2', spend: 240, gmv: 400, deep_score: 5, advertiser_id: '7218', id: 2, month: '2026-09' },
];

test('buildOverview totals GMV and spend, computes blended ROAS, AOV, and channel split', () => {
  const o = buildOverview(shopMonthly, adsMonthly);
  assert.equal(o.gmv, 1500);
  assert.equal(o.spend, 400);
  assert.equal(o.orders, 15);
  assert.equal(o.roas, 3.75);           // 1500 / 400
  assert.equal(o.aov, 100);             // 1500 / 15
  assert.deepEqual(o.channel, { live: 400, video: 1000, product_card: 100 });
});

test('buildOverview: zero spend yields roas 0 (never divide-by-zero)', () => {
  assert.equal(buildOverview(shopMonthly, []).roas, 0);
  assert.equal(buildOverview([], []).aov, 0);
});

test('buildShops joins the shop name and carries per-shop metrics + channel split', () => {
  const shops = buildShops(shopMonthly, shopsMeta);
  assert.equal(shops[0].name, 'Lilsheep Shop');
  assert.equal(shops[0].gmv, 1000);
  assert.equal(shops[0].aov, 100);
  assert.deepEqual(shops[0].channel, { live: 400, video: 500, product_card: 100 });
  assert.deepEqual(shops[0].top_products, [{ name: 'A' }]);
});

test('buildAds adds per-row roas (gmv_ads / spend, 0 when no spend)', () => {
  const ads = buildAds(adsMonthly);
  assert.equal(ads[0].roas, 3);         // 900 / 300
  assert.equal(ads[1].roas, 0);         // gmv_ads 0
});

test('buildAds carries the per-objective awareness split through to the DTO (0 when absent)', () => {
  const ads = buildAds(adsMonthly);
  const vv = ads.find((a) => a.campaign_type === 'video_view');
  assert.equal(vv.video_6s, 3000); assert.equal(vv.video_15s, 1200); assert.equal(vv.video_completed, 600);
  assert.equal(vv.likes, 500); assert.equal(vv.comments, 4); assert.equal(vv.shares, 5); assert.equal(vv.profile_visits, 200);
  const conv = ads.find((a) => a.campaign_type === 'conversion');
  assert.equal(conv.video_6s, 0); assert.equal(conv.likes, 0);   // row without the fields -> 0, never undefined
});

test('buildClips sorts by spend descending and projects only UI fields (drops advertiser_id/id/month)', () => {
  const clips = buildClips(adsItems);
  assert.deepEqual(clips.map((c) => c.ad_id), ['a2', 'a1']);
  const keys = Object.keys(clips[0]).sort();
  assert.deepEqual(keys, ['ad_id', 'ad_name', 'campaign_type', 'caption', 'cover_url', 'gmv', 'results', 'result_label', 'spend', 'video_url', 'video_views'].sort());
  assert.ok(!('advertiser_id' in clips[0]) && !('id' in clips[0]) && !('month' in clips[0]));
});

// GMV Max: Lilsheep's "sales ad" data (the normal ads path only sees awareness campaigns). Sanity
// numbers lifted from a real August 2026 pull (advertiser 7218524808659615746 / store
// 7494836523330930707): LIVE cost 2,800,358 / gross_revenue 11,706,906 / roi ~4.18;
// PRODUCT cost 3,586,600 / gross_revenue 11,487,792 / roi ~3.20.
const gmvmaxRows = [
  { promotion_type: 'LIVE', cost: 2800358, net_cost: 2700000, gross_revenue: 11706906, roi: 4.18, orders: 29912 },
  { promotion_type: 'PRODUCT', cost: 3586600, net_cost: 3400000, gross_revenue: 11487792, roi: 3.2, orders: 30793 },
];

test('buildGmvMax splits LIVE vs PRODUCT and recomputes roi (never averages the stored per-row roi)', () => {
  const g = buildGmvMax(gmvmaxRows);
  assert.deepEqual(g.live, { cost: 2800358, gross_revenue: 11706906, roi: 4.18, orders: 29912 });
  assert.deepEqual(g.product, { cost: 3586600, gross_revenue: 11487792, roi: 3.2, orders: 30793 });
  assert.deepEqual(g.total, { cost: 6386958, gross_revenue: 23194698, roi: 3.63, orders: 60705 });
});

test('buildGmvMax sums multiple stores/advertisers into one LIVE/PRODUCT total for the month', () => {
  const rows = [
    { promotion_type: 'LIVE', cost: 100, gross_revenue: 400, orders: 10 },
    { promotion_type: 'LIVE', cost: 50, gross_revenue: 100, orders: 5 },
    { promotion_type: 'PRODUCT', cost: 200, gross_revenue: 200, orders: 20 },
  ];
  const g = buildGmvMax(rows);
  assert.deepEqual(g.live, { cost: 150, gross_revenue: 500, roi: 3.33, orders: 15 });
  assert.deepEqual(g.product, { cost: 200, gross_revenue: 200, roi: 1, orders: 20 });
  assert.deepEqual(g.total, { cost: 350, gross_revenue: 700, roi: 2, orders: 35 });
});

test('buildGmvMax returns all-zero live/product/total for no rows (never divide-by-zero)', () => {
  const zero = { cost: 0, gross_revenue: 0, roi: 0, orders: 0 };
  assert.deepEqual(buildGmvMax([]), { live: zero, product: { ...zero }, total: { ...zero } });
  assert.deepEqual(buildGmvMax(undefined), { live: zero, product: { ...zero }, total: { ...zero } });
});

// Per-clip Top Ads: three leaderboards over m039_video_monthly rows.
// ad_* is the GMV Max ad-attributed per-clip data; likes/comments/shares come from the shop detail
// endpoint (only fetched for the top-N clips, so a clip with no engagement fetched has them null).
const videoRows = [
  { month: '2026-08', video_id: 'v1', title: 'หมีหลับ', username: 'nutthanon', product: 'หมีหลับ',
    gmv: 382687.69, orders: 1337, items_sold: 1350, views: 703958, ctr: 0.0221, gpm: 543.61,
    ad_cost: 127164.86, ad_gross_revenue: 416702.2, ad_orders: 1324, ad_roi: 3.28,
    likes: 4280, comments: 42, shares: 1700, new_followers: 196 },
  { month: '2026-08', video_id: 'v2', title: 'muscle', username: 'crazymuscle', product: 'Whey',
    gmv: 218989.04, orders: 770, items_sold: 778, views: 1059148, ctr: 0.017, gpm: 206.8,
    ad_cost: 128484.7, ad_gross_revenue: 229429.25, ad_orders: 764, ad_roi: 1.79,
    likes: 20996, comments: 23, shares: 29, new_followers: 91 },
  { month: '2026-08', video_id: 'v3', title: 'organic only', username: 'fon', product: 'X',
    gmv: 50000, orders: 100, items_sold: 100, views: 30000, ctr: 0.03, gpm: 900,
    ad_cost: null, ad_gross_revenue: null, ad_orders: null, ad_roi: null,
    likes: null, comments: null, shares: null, new_followers: null },
];

test('buildVideos.sales curates to the winners: ad-spent clips with ROI >= benchmark, ranked by ad revenue', () => {
  const v = buildVideos(videoRows, { benchmark: 3 });
  assert.equal(v.benchmark, 3);
  assert.deepEqual(v.sales.map((r) => r.video_id), ['v1']);   // v1 ROI 3.28 >= 3; v2 (1.79) below benchmark, v3 no ad spend -> both excluded
  assert.equal(v.sales[0].ad_roi, 3.28);
  assert.equal(v.sales[0].roi_ok, true);
});

test('buildVideos.sales ranks the qualifying winners by ad revenue', () => {
  const rows = [
    { video_id: 'w1', username: 'a', ad_cost: 100000, ad_gross_revenue: 350000, ad_orders: 100, ad_roi: 3.5, gmv: 0, orders: 0, views: 0 },
    { video_id: 'w2', username: 'b', ad_cost: 200000, ad_gross_revenue: 700000, ad_orders: 200, ad_roi: 3.5, gmv: 0, orders: 0, views: 0 },
    { video_id: 'w3', username: 'c', ad_cost: 100000, ad_gross_revenue: 900000, ad_orders: 250, ad_roi: 2.0, gmv: 0, orders: 0, views: 0 },   // huge revenue but ROI < 3 -> excluded
  ];
  const v = buildVideos(rows, { benchmark: 3 });
  assert.deepEqual(v.sales.map((r) => r.video_id), ['w2', 'w1']);   // both ROI>=3, ranked by revenue; w3 dropped despite top revenue
});

test('buildVideos.engagement ranks by likes+comments+shares (clips with no detail measured are excluded)', () => {
  const v = buildVideos(videoRows, { benchmark: 3 });
  assert.deepEqual(v.engagement.map((r) => r.video_id), ['v2', 'v1']);   // v2: 20996+23+29 > v1: 4280+42+1700; v3 null -> out
  assert.equal(v.engagement[0].engagement, 21048);
});

test('buildVideos.reach ranks clips by a composite awareness score (views/ctr/comments/shares), 0-100', () => {
  const v = buildVideos(videoRows, { benchmark: 3 });
  assert.equal(v.reach[0].video_id, 'v1');   // v1 tops comments+shares -> highest composite score
  assert.ok(v.reach.every((r) => r.score >= 0 && r.score <= 100));
  assert.ok(v.reach[0].score >= v.reach[1].score);
});

test('buildVideos.reach composite score averages the four normalized criteria', () => {
  const rows = [
    { video_id: 'r1', username: 'a', views: 1000, ctr: 0.02, comments: 10, shares: 20, gmv: 0 },   // max on every metric
    { video_id: 'r2', username: 'b', views: 500, ctr: 0.01, comments: 5, shares: 10, gmv: 0 },      // half on every metric
  ];
  const v = buildVideos(rows, { benchmark: 3 });
  assert.deepEqual(v.reach.map((r) => r.video_id), ['r1', 'r2']);
  assert.equal(v.reach[0].score, 100);   // (1+1+1+1)/4 * 100
  assert.equal(v.reach[1].score, 50);    // (.5+.5+.5+.5)/4 * 100
});

const productRows = [
  { product: 'Sleep Well', gmv: 100, orders: 3, views: 1000, ad_cost: 50, ad_gross_revenue: 200 },
  { product: 'Sleep Well', gmv: 50, orders: 1, views: 500, ad_cost: null, ad_gross_revenue: null },
  { product: 'Lion mane', gmv: 80, orders: 2, views: 800, ad_cost: 40, ad_gross_revenue: 120 },
  { product: '', gmv: 10, orders: 1, views: 100, ad_cost: 0, ad_gross_revenue: 0 },   // no product -> skipped
];

test('buildInsights computes ACoS + Ads-claim% and raises the right alerts/highlights', () => {
  const i = buildInsights({
    overview: { gmv: 9600000, refund: 250000 },
    gmvmax: { total: { cost: 2930000, gross_revenue: 11200000, roi: 3.48 }, live: { roi: 4.03 }, product: { roi: 2.92 } },
    awareSpend: 233000, refund: 250000, trend: [], benchmark: 3,
  });
  assert.equal(i.totalSpend, 3163000);
  assert.equal(i.acos, 32.95);       // ค่าแอดรวม ÷ ยอดร้าน = 3.163M / 9.6M
  assert.equal(i.claimPct, 116.67);  // Ads claim 11.2M / shop 9.6M -> exceeds 100%
  assert.ok(i.alerts.some((a) => /Product GMV Max.*ต่ำกว่าเกณฑ์/.test(a)), 'product 2.92 < 3 alert');
  assert.ok(i.alerts.some((a) => /attribution|เคลม/.test(a)), 'claim >90% warning');
  assert.ok(i.highlights.some((h) => /ROI GMV Max 3\.48 เหนือเกณฑ์/.test(h)));
  assert.ok(!i.alerts.some((a) => /ROI GMV Max.*ต่ำกว่า/.test(a)), 'total ROI 3.48 >= 3 -> no total-roi alert');
});

test('buildInsights flags a 3-month Blended ROI decline and is safe on empty input', () => {
  const dec = buildInsights({ overview: { gmv: 100 }, gmvmax: { total: { cost: 10, gross_revenue: 40, roi: 4 } }, trend: [{ blended_roi: 3.5 }, { blended_roi: 3.3 }, { blended_roi: 3.1 }], benchmark: 3 });
  assert.ok(dec.alerts.some((a) => /Blended ROI ลงต่อเนื่อง/.test(a)));
  const empty = buildInsights({});
  assert.equal(empty.acos, 0);
  assert.deepEqual(empty.alerts, []);
});

test('buildInsights scopes the ROI-decline check to the SELECTED month, not the newest 3', () => {
  const trend = [
    { month: '2026-03', blended_roi: 3.6 }, { month: '2026-04', blended_roi: 3.4 }, { month: '2026-05', blended_roi: 3.2 },  // ending May: declining
    { month: '2026-06', blended_roi: 3.0 }, { month: '2026-07', blended_roi: 3.5 }, { month: '2026-08', blended_roi: 3.6 },  // newest 3 (Jun→Aug): NOT a decline
  ];
  const base = { overview: { gmv: 100 }, gmvmax: { total: { cost: 10, gross_revenue: 40, roi: 4 } }, trend, benchmark: 3 };
  assert.ok(buildInsights({ ...base, month: '2026-05' }).alerts.some((a) => /Blended ROI ลงต่อเนื่อง/.test(a)), 'May 3.6→3.4→3.2 fires');
  assert.ok(!buildInsights({ ...base, month: '2026-08' }).alerts.some((a) => /Blended ROI ลงต่อเนื่อง/.test(a)), 'Aug last-3 3.0→3.5→3.6 does not fire');
});

test('buildAdChannels splits per-clip GMV Max ad spend into brand vs creator channels with counts + roi', () => {
  const rows = [
    { username: 'lilsheep.official', ad_cost: 100, ad_gross_revenue: 300, ad_orders: 3 },
    { username: 'lilsheepcafe', ad_cost: 50, ad_gross_revenue: 100, ad_orders: 1 },
    { username: 'nutthanon', ad_cost: 200, ad_gross_revenue: 600, ad_orders: 6 },
    { username: 'crazymuscle', ad_cost: 100, ad_gross_revenue: 200, ad_orders: 2 },
    { username: 'x', ad_cost: 0, ad_gross_revenue: 0, ad_orders: 0 },   // no ad spend -> skipped
  ];
  const a = buildAdChannels(rows, ['lilsheep.official', 'lilsheepcafe']);
  assert.deepEqual([a.brand.spend, a.brand.clips], [150, 2]);
  assert.equal(a.brand.roi, 2.67);                                  // 400 / 150
  assert.deepEqual([a.creator.spend, a.creator.clips, a.creator.creators], [300, 2, 2]);
  assert.equal(a.creator.roi, 2.67);                                // 800 / 300
  assert.equal(a.clips_total, 4);
});

test('buildAdChannels is safe on empty input', () => {
  const a = buildAdChannels([], []);
  assert.deepEqual([a.brand.spend, a.creator.spend, a.clips_total], [0, 0, 0]);
});

test('buildProducts aggregates clips by product with gmv/orders/views/clips + ad cost/roi (recomputed)', () => {
  const p = buildProducts(productRows);
  assert.deepEqual(p.map((x) => x.product), ['Sleep Well', 'Lion mane']);   // by gmv desc
  const sw = p[0];
  assert.deepEqual([sw.clips, sw.gmv, sw.orders, sw.views], [2, 150, 4, 1500]);
  assert.equal(sw.ad_cost, 50);
  assert.equal(sw.ad_gross_revenue, 200);
  assert.equal(sw.ad_roi, 4);   // round2(200/50)
  assert.ok(!p.some((x) => x.product === ''), 'blank product skipped');
});

test('buildVideos passes each clip cover_url through to the leaderboard rows (for the card thumbnails)', () => {
  const rows = videoRows.map((r) => ({ ...r, cover_url: 'https://cdn/' + r.video_id + '.jpg' }));
  const v = buildVideos(rows, { benchmark: 3 });
  assert.equal(v.sales[0].cover, 'https://cdn/v1.jpg');
  assert.equal(v.engagement[0].cover, 'https://cdn/v2.jpg');
  assert.equal(v.reach[0].cover, 'https://cdn/v1.jpg');   // v1 tops the composite reach score
});

test('buildVideos defaults the benchmark to 3 and never throws on empty input', () => {
  const v = buildVideos([]);
  assert.equal(v.benchmark, 3);
  assert.deepEqual(v.sales, []);
  assert.deepEqual(v.engagement, []);
  assert.deepEqual(v.reach, []);
});

// Affiliate tab: monthly growth series + per-creator VDO/Live rankings + carrying-product counts.
const affMonthly = [
  { month: '2026-07', gmv_video: 6249356, gmv_live: 186249, orders_video: 20000, orders_live: 900, video_count: 33072, live_count: 8404 },
  { month: '2026-08', gmv_video: 7092935, gmv_live: 348525, orders_video: 22431, orders_live: 1059, video_count: 34067, live_count: 7901 },
];
const affCreators = [
  { month: '2026-08', username: 'nutthanon', videos: 6, gmv_video: 425202, orders_video: 1486, views_video: 900000, lives: 0, gmv_live: 0, orders_live: 0 },
  { month: '2026-08', username: 'papartor', videos: 0, gmv_video: 0, orders_video: 0, views_video: 0, lives: 33, gmv_live: 265763, orders_live: 811 },
];

test('buildAffiliate assembles growth (asc), carrying-product counts, and top VDO/Live creator rankings', () => {
  const a = buildAffiliate(affMonthly, affCreators, { month: '2026-08' });
  assert.deepEqual(a.growth.map((g) => g.month), ['2026-07', '2026-08']);   // ascending for a time series
  assert.deepEqual(a.counts, { videos: 34067, lives: 7901 });
  assert.equal(a.topVideo[0].username, 'nutthanon');   // only creators with video gmv
  assert.equal(a.topVideo.length, 1);
  assert.equal(a.topLive[0].username, 'papartor');      // only creators with live gmv
  assert.equal(a.topLive.length, 1);
  assert.equal(a.locked, true);   // exact "creators who attached" still gated on the TikTok Affiliate scope
});

test('buildAffiliate counts reflect ONLY the selected month (no silent fallback to another month)', () => {
  const a = buildAffiliate(affMonthly, [], { month: '2026-09' });   // 2026-09 has no monthly row
  assert.deepEqual(a.counts, { videos: 0, lives: 0 });               // not the newest month's counts
  assert.deepEqual(a.growth.map((g) => g.month), ['2026-07', '2026-08']);   // growth still shows what exists
});

// Monthly trend: month-over-month series across the shop, GMV Max, and awareness tables.
const trGmvmax = [
  { month: '2026-08', promotion_type: 'LIVE', cost: 2800000, gross_revenue: 11700000, orders: 29000 },
  { month: '2026-08', promotion_type: 'PRODUCT', cost: 3580000, gross_revenue: 11480000, orders: 30000 },
  { month: '2026-09', promotion_type: 'LIVE', cost: 1400000, gross_revenue: 6000000, orders: 12000 },
  { month: '2026-09', promotion_type: 'PRODUCT', cost: 1500000, gross_revenue: 4200000, orders: 13000 },
];
const trShop = [{ month: '2026-08', shop_key: 'S1', gmv: 20000000, orders: 50000 }, { month: '2026-09', shop_key: 'S1', gmv: 8680000, orders: 25000 }];
const trAds = [
  { month: '2026-08', campaign_type: 'video_view', spend: 230000, gmv_ads: 0 },
  { month: '2026-08', campaign_type: 'gmvmax', spend: 100, gmv_ads: 500000 },   // gmv_ads>0 -> not awareness
  { month: '2026-09', campaign_type: 'video_view', spend: 233000, gmv_ads: 0 },
];

test('buildTrend aggregates per month: shop gmv, GMV Max cost/gmv/roi (live+product), awareness spend, blended roi', () => {
  const t = buildTrend(trGmvmax, trShop, trAds);
  assert.deepEqual(t.map((r) => r.month), ['2026-08', '2026-09']);   // ascending time series
  const aug = t[0];
  assert.equal(aug.shop_gmv, 20000000);
  assert.equal(aug.gmvmax_cost, 6380000);
  assert.equal(aug.gmvmax_gmv, 23180000);
  assert.equal(aug.gmvmax_roi, 3.63);       // 23.18M / 6.38M
  assert.equal(aug.live_roi, 4.18);         // 11.7M / 2.8M
  assert.equal(aug.product_roi, 3.21);      // 11.48M / 3.58M
  assert.equal(aug.aware_spend, 230000);    // only gmv_ads<=0 campaigns
  assert.equal(aug.total_spend, 6610000);   // 6.38M + 230k
  assert.equal(aug.blended_roi, 3.51);      // 23.18M / 6.61M
});

test('buildTrend never divides by zero and is safe on empty input', () => {
  assert.deepEqual(buildTrend([], [], []), []);
  const t = buildTrend([{ month: '2026-07', promotion_type: 'LIVE', cost: 0, gross_revenue: 0, orders: 0 }], [], []);
  assert.equal(t[0].gmvmax_roi, 0);
  assert.equal(t[0].blended_roi, 0);
});

test('buildAffiliate is safe on empty input (no month row, no creators)', () => {
  const a = buildAffiliate([], [], { month: '2026-08' });
  assert.deepEqual(a.growth, []);
  assert.deepEqual(a.counts, { videos: 0, lives: 0 });
  assert.deepEqual(a.topVideo, []);
  assert.deepEqual(a.topLive, []);
});
