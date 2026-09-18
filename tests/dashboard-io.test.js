import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDashboard } from '../lib/dashboard.js';

test('loadDashboard fetches the four m039_ tables for the month and assembles the DTO', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const seen = [];
  const fakeFetch = async (url) => {
    const u = String(url); seen.push(u);
    const body =
      u.includes('/m039_shop_monthly') ? [{ shop_key: 'S1', gmv: 1000, orders: 10, gmv_live: 400, gmv_video: 500, gmv_product_card: 100 }] :
      u.includes('/m039_shops') ? [{ key: 'S1', name: 'Lilsheep Shop' }] :
      u.includes('/m039_ads_monthly') ? [{ campaign_type: 'conversion', spend: 300, gmv_ads: 900, result_label: 'Conv' }] :
      u.includes('/m039_ads_items') ? [{ ad_id: 'a1', spend: 60, gmv: 500 }] : [];
    return { status: 200, async text() { return JSON.stringify(body); } };
  };
  const dto = await loadDashboard({ cfg, month: '2026-09', fetchImpl: fakeFetch });
  assert.equal(dto.month, '2026-09');
  assert.equal(dto.overview.gmv, 1000);
  assert.equal(dto.overview.roas, 3.33);
  assert.equal(dto.shops[0].name, 'Lilsheep Shop');
  assert.equal(dto.ads[0].roas, 3);
  assert.equal(dto.clips[0].ad_id, 'a1');
  // month-scoped queries + clips ordered by spend
  assert.ok(seen.some((u) => u.includes('/m039_shop_monthly') && u.includes('month=eq.2026-09')));
  assert.ok(seen.some((u) => u.includes('/m039_ads_items') && u.includes('order=spend.desc')));
});

test('loadDashboard reads m039_video_monthly and assembles the per-clip Top Ads (videos) block', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const seen = [];
  const fakeFetch = async (url) => {
    const u = String(url); seen.push(u);
    const body = u.includes('/m039_video_monthly')
      ? [{ month: '2026-08', video_id: 'v1', title: 'หมีหลับ', username: 'nutthanon', gmv: 382687, orders: 1337, views: 703958, ctr: 0.02, gpm: 500, ad_cost: 127164.86, ad_gross_revenue: 416702.2, ad_orders: 1324, ad_roi: 3.28, likes: 4280, comments: 42, shares: 1700, new_followers: 196 }]
      : [];
    return { status: 200, async text() { return JSON.stringify(body); } };
  };
  const dto = await loadDashboard({ cfg, month: '2026-08', fetchImpl: fakeFetch });
  assert.ok(seen.some((u) => u.includes('/m039_video_monthly') && u.includes('month=eq.2026-08')));
  assert.equal(dto.benchmark, 3);
  assert.equal(dto.videos.sales[0].video_id, 'v1');
  assert.equal(dto.videos.sales[0].roi_ok, true);       // 3.28 >= 3
  assert.equal(dto.videos.engagement[0].engagement, 6022);
  assert.equal(dto.videos.reach[0].views, 703958);
});

test('loadDashboard reads the affiliate tables and assembles the affiliate block', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const seen = [];
  const fakeFetch = async (url) => {
    const u = String(url); seen.push(u);
    const body =
      u.includes('/m039_affiliate_monthly') ? [{ month: '2026-08', gmv_video: 7092935, gmv_live: 348525, orders_video: 22431, orders_live: 1059, video_count: 34067, live_count: 7901 }] :
      u.includes('/m039_affiliate_creators') ? [{ month: '2026-08', username: 'nutthanon', gmv_video: 425202, orders_video: 1486, views_video: 900000, videos: 6, gmv_live: 0, orders_live: 0, lives: 0 }] : [];
    return { status: 200, async text() { return JSON.stringify(body); } };
  };
  const dto = await loadDashboard({ cfg, month: '2026-08', fetchImpl: fakeFetch });
  assert.ok(seen.some((u) => u.includes('/m039_affiliate_monthly')));
  assert.ok(seen.some((u) => u.includes('/m039_affiliate_creators') && u.includes('month=eq.2026-08')));
  assert.equal(dto.affiliate.counts.videos, 34067);
  assert.equal(dto.affiliate.topVideo[0].username, 'nutthanon');
});

test('loadDashboard reads all-month tables and assembles the trend series', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const fakeFetch = async (url) => {
    const u = String(url);
    let body = [];
    if (u.includes('/m039_gmvmax_monthly') && !u.includes('month=eq')) body = [{ month: '2026-08', promotion_type: 'LIVE', cost: 100, gross_revenue: 400, orders: 4 }, { month: '2026-09', promotion_type: 'LIVE', cost: 100, gross_revenue: 300, orders: 3 }];
    else if (u.includes('/m039_shop_monthly') && !u.includes('month=eq')) body = [{ month: '2026-08', gmv: 1000 }, { month: '2026-09', gmv: 800 }];
    else if (u.includes('/m039_ads_monthly') && !u.includes('month=eq')) body = [{ month: '2026-08', spend: 50, gmv_ads: 0 }];
    return { status: 200, async text() { return JSON.stringify(body); } };
  };
  const dto = await loadDashboard({ cfg, month: '2026-08', fetchImpl: fakeFetch });
  assert.deepEqual(dto.trend.map((r) => r.month), ['2026-08', '2026-09']);
  assert.equal(dto.trend[0].gmvmax_gmv, 400);
  assert.equal(dto.trend[0].shop_gmv, 1000);
  assert.equal(dto.trend[0].aware_spend, 50);
});

test('loadDashboard treats a non-2xx table read as empty (never crashes the DTO)', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const fakeFetch = async () => ({ status: 500, async text() { return 'boom'; } });
  const dto = await loadDashboard({ cfg, month: '2026-09', fetchImpl: fakeFetch });
  assert.equal(dto.overview.gmv, 0);
  assert.deepEqual(dto.shops, []);
  assert.deepEqual(dto.ads, []);
  assert.deepEqual(dto.clips, []);
  assert.deepEqual(dto.gmvmax, { live: { cost: 0, gross_revenue: 0, roi: 0, orders: 0 }, product: { cost: 0, gross_revenue: 0, roi: 0, orders: 0 }, total: { cost: 0, gross_revenue: 0, roi: 0, orders: 0 } });
});

test('loadDashboard also reads m039_gmvmax_monthly for the month and assembles the gmvmax DTO block (does not break the existing overview/shops/ads/clips shape)', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const seen = [];
  const fakeFetch = async (url) => {
    const u = String(url); seen.push(u);
    const body =
      u.includes('/m039_gmvmax_monthly') ? [
        { promotion_type: 'LIVE', cost: 2800358, gross_revenue: 11706906, orders: 29912 },
        { promotion_type: 'PRODUCT', cost: 3586600, gross_revenue: 11487792, orders: 30793 },
      ] :
      u.includes('/m039_shop_monthly') ? [{ shop_key: 'S1', gmv: 1000, orders: 10, gmv_live: 400, gmv_video: 500, gmv_product_card: 100 }] :
      u.includes('/m039_shops') ? [{ key: 'S1', name: 'Lilsheep Shop' }] :
      u.includes('/m039_ads_monthly') ? [{ campaign_type: 'conversion', spend: 300, gmv_ads: 900, result_label: 'Conv' }] :
      u.includes('/m039_ads_items') ? [{ ad_id: 'a1', spend: 60, gmv: 500 }] : [];
    return { status: 200, async text() { return JSON.stringify(body); } };
  };
  const dto = await loadDashboard({ cfg, month: '2026-08', fetchImpl: fakeFetch });
  assert.ok(seen.some((u) => u.includes('/m039_gmvmax_monthly') && u.includes('month=eq.2026-08')));
  assert.equal(dto.gmvmax.live.cost, 2800358);
  assert.equal(dto.gmvmax.product.cost, 3586600);
  assert.equal(dto.gmvmax.total.gross_revenue, 23194698);
  // existing DTO shape untouched
  assert.equal(dto.overview.gmv, 1000);
  assert.equal(dto.shops[0].name, 'Lilsheep Shop');
  assert.equal(dto.ads[0].roas, 3);
  assert.equal(dto.clips[0].ad_id, 'a1');
});
