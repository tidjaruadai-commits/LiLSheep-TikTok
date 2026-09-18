import { dbFetch } from './db.js';

const sum = (rows, f) => rows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const roas = (gmv, spend) => (spend > 0 ? round2(gmv / spend) : 0);

export function buildOverview(shopMonthly, adsMonthly) {
  const gmv = round2(sum(shopMonthly, 'gmv'));
  const spend = round2(sum(adsMonthly, 'spend'));
  const orders = sum(shopMonthly, 'orders');
  return {
    gmv, spend, orders,
    roas: roas(gmv, spend),
    aov: orders > 0 ? round2(gmv / orders) : 0,
    channel: {
      live: round2(sum(shopMonthly, 'gmv_live')),
      video: round2(sum(shopMonthly, 'gmv_video')),
      product_card: round2(sum(shopMonthly, 'gmv_product_card')),
    },
  };
}

export function buildShops(shopMonthly, shopsMeta) {
  const nameByKey = Object.fromEntries((shopsMeta || []).map((s) => [s.key, s.name]));
  return (shopMonthly || []).map((r) => ({
    key: r.shop_key,
    name: nameByKey[r.shop_key] || r.shop_key,
    gmv: round2(r.gmv), refund: round2(r.refund), orders: r.orders || 0, units: r.units || 0,
    aov: r.orders ? round2(r.gmv / r.orders) : 0,
    channel: { live: round2(r.gmv_live), video: round2(r.gmv_video), product_card: round2(r.gmv_product_card) },
    top_products: Array.isArray(r.top_products) ? r.top_products : [],
    live_sessions: Array.isArray(r.live_sessions) ? r.live_sessions : [],
  }));
}

export function buildAds(adsMonthly) {
  return (adsMonthly || []).map((r) => ({
    campaign_type: r.campaign_type, result_label: r.result_label || '',
    spend: round2(r.spend), impressions: r.impressions || 0, clicks: r.clicks || 0,
    results: r.results || 0, video_views: r.video_views || 0, gmv_ads: round2(r.gmv_ads),
    roas: roas(r.gmv_ads, r.spend),
    // per-objective awareness split (0 when TikTok doesn't report it for that objective)
    video_6s: r.video_6s || 0, video_15s: r.video_15s || 0, video_completed: r.video_completed || 0,
    likes: r.likes || 0, comments: r.comments || 0, shares: r.shares || 0, profile_visits: r.profile_visits || 0,
  }));
}

export function buildClips(adsItems) {
  return (adsItems || [])
    .map((r) => ({
      ad_id: r.ad_id, ad_name: r.ad_name || '', caption: r.caption || '', campaign_type: r.campaign_type || '',
      cover_url: r.cover_url || '', video_url: r.video_url || '',
      spend: round2(r.spend), results: r.results || 0, result_label: r.result_label || '',
      video_views: r.video_views || 0, gmv: round2(r.gmv),
    }))
    .sort((a, b) => (b.spend || 0) - (a.spend || 0));
}

// GMV Max: Lilsheep's "sales ad" data (the normal ads path only ever returns awareness campaigns).
// Sums every row for the month by promotion_type (there can be several stores/advertisers), then
// recomputes roi from the summed totals — never averages the per-row roi that came back from TikTok.
export function buildGmvMax(rows) {
  const side = { cost: 0, gross_revenue: 0, orders: 0 };
  const live = { ...side };
  const product = { ...side };
  for (const r of (rows || [])) {
    const bucket = r && r.promotion_type === 'LIVE' ? live : r && r.promotion_type === 'PRODUCT' ? product : null;
    if (!bucket) continue;
    bucket.cost += Number(r.cost) || 0;
    bucket.gross_revenue += Number(r.gross_revenue) || 0;
    bucket.orders += Number(r.orders) || 0;
  }
  const finish = (b) => ({ cost: round2(b.cost), gross_revenue: round2(b.gross_revenue), roi: roas(b.gross_revenue, b.cost), orders: b.orders });
  const total = { cost: live.cost + product.cost, gross_revenue: live.gross_revenue + product.gross_revenue, orders: live.orders + product.orders };
  return { live: finish(live), product: finish(product), total: finish(total) };
}

// Per-clip Top Ads: three leaderboards over m039_video_monthly. `sales` = clips we put GMV Max ad
// money behind, ranked by ad revenue with roi flagged against the owner's benchmark (>=3 is green).
// `engagement` = clips whose likes/comments/shares were measured (top-N detail), ranked by their sum.
// `reach` = every clip by views. Benchmark defaults to 3 (Lilsheep's floor).
const VID_TOP = 20;
export function buildVideos(rows, { benchmark = 3 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // "คลิปทำยอดขาย + ROI" is the scale-these list: clips we put ad money behind that cleared the ROI
  // benchmark, ranked by ad revenue (so high-spend/high-revenue winners lead).
  const sales = list
    .filter((r) => Number(r.ad_cost) > 0 && Number(r.ad_roi) >= benchmark)
    .map((r) => ({
      video_id: r.video_id, title: r.title || '', username: r.username || '', product: r.product || '', cover: r.cover_url || '',
      gmv: round2(r.gmv), orders: r.orders || 0, views: r.views || 0,
      ad_cost: round2(r.ad_cost), ad_gross_revenue: round2(r.ad_gross_revenue), ad_orders: r.ad_orders || 0,
      ad_roi: round2(r.ad_roi), roi_ok: Number(r.ad_roi) >= benchmark,
    }))
    .sort((a, b) => (b.ad_gross_revenue || 0) - (a.ad_gross_revenue || 0))
    .slice(0, VID_TOP);
  const engagement = list
    .map((r) => ({ r, eng: (Number(r.likes) || 0) + (Number(r.comments) || 0) + (Number(r.shares) || 0) }))
    .filter((x) => x.eng > 0)
    .sort((a, b) => b.eng - a.eng)
    .slice(0, VID_TOP)
    .map(({ r, eng }) => ({
      video_id: r.video_id, title: r.title || '', username: r.username || '', cover: r.cover_url || '', views: r.views || 0,
      likes: r.likes || 0, comments: r.comments || 0, shares: r.shares || 0, new_followers: r.new_followers || 0,
      engagement: eng,
    }));
  // "การรับรู้" ranks by a composite score: each of views / CTR / comments / shares normalized to the
  // set's max (0-1), averaged, ×100. (TikTok's shop API gives no watch/completion rate, so that
  // criterion isn't available — CTR + engagement stand in for "อัตราการดู".)
  const reachRaw = list.filter((r) => Number(r.views) > 0).map((r) => ({
    video_id: r.video_id, title: r.title || '', username: r.username || '', cover: r.cover_url || '',
    views: r.views || 0, ctr: Number(r.ctr) || 0, comments: Number(r.comments) || 0, shares: Number(r.shares) || 0, gmv: round2(r.gmv),
  }));
  const mx = (f) => reachRaw.reduce((m, r) => Math.max(m, r[f] || 0), 0);
  const maxV = mx('views'), maxC = mx('ctr'), maxCom = mx('comments'), maxSh = mx('shares');
  const nn = (v, max) => (max > 0 ? v / max : 0);
  const reach = reachRaw
    .map((r) => ({ ...r, score: round2((nn(r.views, maxV) + nn(r.ctr, maxC) + nn(r.comments, maxCom) + nn(r.shares, maxSh)) / 4 * 100) }))
    .sort((a, b) => (b.score - a.score) || (b.views - a.views))
    .slice(0, VID_TOP);
  return { benchmark, sales, engagement, reach };
}

// Per-product analysis: aggregate the month's clips (m039_video_monthly) by product name → sales,
// orders, views, clip count, and ad cost/ROI (recomputed from summed totals). Sorted by GMV.
export function buildProducts(videoRows) {
  const byProduct = new Map();
  for (const r of (Array.isArray(videoRows) ? videoRows : [])) {
    const p = String(r.product || '').trim(); if (!p) continue;
    let o = byProduct.get(p);
    if (!o) { o = { product: p, clips: 0, gmv: 0, orders: 0, views: 0, ad_cost: 0, ad_gross_revenue: 0 }; byProduct.set(p, o); }
    o.clips += 1;
    o.gmv += Number(r.gmv) || 0; o.orders += Number(r.orders) || 0; o.views += Number(r.views) || 0;
    o.ad_cost += Number(r.ad_cost) || 0; o.ad_gross_revenue += Number(r.ad_gross_revenue) || 0;
  }
  return [...byProduct.values()].map((o) => ({
    product: o.product, clips: o.clips, gmv: round2(o.gmv), orders: o.orders, views: o.views,
    ad_cost: round2(o.ad_cost), ad_gross_revenue: round2(o.ad_gross_revenue),
    ad_roi: o.ad_cost > 0 ? round2(o.ad_gross_revenue / o.ad_cost) : 0,
  })).sort((a, b) => b.gmv - a.gmv);
}

// Affiliate tab: a monthly growth series + this month's per-creator VDO/Live rankings + the
// carrying-product counts. `locked` marks the exact "creators who attached the product" metric,
// which stays gated on the TikTok Affiliate Seller scope (see m039-per-video-gmv-api memory).
export function buildAffiliate(monthlyRows, creatorRows, { month } = {}) {
  const monthly = (Array.isArray(monthlyRows) ? monthlyRows : []).slice()
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));
  const growth = monthly.map((m) => ({
    month: m.month, gmv_video: round2(m.gmv_video), gmv_live: round2(m.gmv_live),
    orders_video: m.orders_video || 0, orders_live: m.orders_live || 0,
  }));
  const cur = monthly.find((m) => m.month === month) || {};   // counts are for the selected month only (no fallback)
  const creators = Array.isArray(creatorRows) ? creatorRows : [];
  const topVideo = creators.filter((r) => Number(r.gmv_video) > 0)
    .map((r) => ({ username: r.username, videos: r.videos || 0, gmv: round2(r.gmv_video), orders: r.orders_video || 0, views: r.views_video || 0 }))
    .sort((a, b) => b.gmv - a.gmv).slice(0, 20);
  const topLive = creators.filter((r) => Number(r.gmv_live) > 0)
    .map((r) => ({ username: r.username, lives: r.lives || 0, gmv: round2(r.gmv_live), orders: r.orders_live || 0 }))
    .sort((a, b) => b.gmv - a.gmv).slice(0, 20);
  return { locked: true, counts: { videos: cur.video_count || 0, lives: cur.live_count || 0 }, growth, topVideo, topLive };
}

// Monthly trend: a month-over-month series across the shop, GMV Max, and awareness tables, for the
// comparison graphs. ROI is recomputed from the summed totals each month (never averaged).
export function buildTrend(gmvmaxAll, shopAll, adsAll) {
  const months = new Set();
  const gm = new Map();     // month -> {liveCost,liveRev,prodCost,prodRev}
  for (const r of (Array.isArray(gmvmaxAll) ? gmvmaxAll : [])) {
    const m = r.month; months.add(m);
    const o = gm.get(m) || { liveCost: 0, liveRev: 0, prodCost: 0, prodRev: 0 };
    const c = Number(r.cost) || 0, rev = Number(r.gross_revenue) || 0;
    if (r.promotion_type === 'LIVE') { o.liveCost += c; o.liveRev += rev; }
    else if (r.promotion_type === 'PRODUCT') { o.prodCost += c; o.prodRev += rev; }
    gm.set(m, o);
  }
  const shop = new Map();
  for (const r of (Array.isArray(shopAll) ? shopAll : [])) { months.add(r.month); shop.set(r.month, (shop.get(r.month) || 0) + (Number(r.gmv) || 0)); }
  const aware = new Map();   // awareness = campaigns that drove no onsite GMV (gmv_ads <= 0)
  for (const r of (Array.isArray(adsAll) ? adsAll : [])) { if ((Number(r.gmv_ads) || 0) > 0) continue; months.add(r.month); aware.set(r.month, (aware.get(r.month) || 0) + (Number(r.spend) || 0)); }
  return [...months].sort().map((m) => {
    const g = gm.get(m) || { liveCost: 0, liveRev: 0, prodCost: 0, prodRev: 0 };
    const cost = g.liveCost + g.prodCost, rev = g.liveRev + g.prodRev;
    const aw = aware.get(m) || 0, total = cost + aw;
    return {
      month: m, shop_gmv: round2(shop.get(m) || 0),
      gmvmax_cost: round2(cost), gmvmax_gmv: round2(rev), gmvmax_roi: roas(rev, cost),
      live_roi: roas(g.liveRev, g.liveCost), product_roi: roas(g.prodRev, g.prodCost),
      aware_spend: round2(aw), total_spend: round2(total), blended_roi: roas(rev, total),
    };
  });
}

// Turn the month's numbers into decisions: the two ratios an owner watches (ACoS, Ads-claim share of
// real shop sales) plus auto alerts (ROI below the benchmark, ad-attribution overlapping the whole
// shop, a multi-month ROI decline, high refunds) and highlights. Pure — all inputs come from the DTO.
export function buildInsights({ overview = {}, gmvmax = {}, awareSpend = 0, refund = 0, trend = [], benchmark = 3, month = '' } = {}) {
  const shopGmv = Number(overview.gmv) || 0;
  const g = gmvmax.total || { cost: 0, gross_revenue: 0, roi: 0 };
  const live = gmvmax.live || {}, product = gmvmax.product || {};
  const totalSpend = round2((Number(g.cost) || 0) + (Number(awareSpend) || 0));
  const acos = shopGmv > 0 ? round2(totalSpend / shopGmv * 100) : 0;
  const claimPct = shopGmv > 0 ? round2((Number(g.gross_revenue) || 0) / shopGmv * 100) : 0;
  const refundPct = shopGmv > 0 ? round2((Number(refund) || 0) / shopGmv * 100) : 0;
  const roi = Number(g.roi) || 0, liveRoi = Number(live.roi) || 0, prodRoi = Number(product.roi) || 0;
  const alerts = [], highlights = [];
  if (roi > 0 && roi < benchmark) alerts.push(`ROI GMV Max ${roi.toFixed(2)} ต่ำกว่าเกณฑ์ ${benchmark}`);
  else if (roi >= benchmark) highlights.push(`ROI GMV Max ${roi.toFixed(2)} เหนือเกณฑ์ ${benchmark} ✓`);
  if (liveRoi > 0 && liveRoi < benchmark) alerts.push(`Live GMV Max ROI ${liveRoi.toFixed(2)} ต่ำกว่าเกณฑ์`);
  if (prodRoi > 0 && prodRoi < benchmark) alerts.push(`Product GMV Max (VDO) ROI ${prodRoi.toFixed(2)} ต่ำกว่าเกณฑ์`);
  if (claimPct >= 90) alerts.push(`ยอดขายจาก Ads เคลม ${claimPct.toFixed(0)}% ของยอดร้าน — attribution ทับซ้อน ROI จริงอาจต่ำกว่าที่เห็น`);
  if (refundPct >= 5) alerts.push(`ยอดคืน/ยกเลิก ${refundPct.toFixed(1)}% ของยอดร้าน`);
  const upto = (Array.isArray(trend) ? trend : []).filter((t) => !month || String(t.month) <= month);   // up to the selected month, not the newest in the DB
  if (upto.length >= 3) {
    const l = upto.slice(-3).map((t) => Number(t.blended_roi) || 0);
    if (l[0] > l[1] && l[1] > l[2]) alerts.push(`Blended ROI ลงต่อเนื่อง 3 เดือน (${l[0].toFixed(2)} → ${l[2].toFixed(2)})`);
  }
  return { acos, claimPct, refundPct, totalSpend, alerts, highlights };
}

// Split the month's per-clip GMV Max ad spend (Product GMV Max) into brand-owned channels vs
// creator/affiliate channels, with clip + distinct-creator counts and recomputed ROI. brandUsers is
// the allowlist of the brand's own TikTok handles; everything else counts as a creator.
export function buildAdChannels(videoRows, brandUsers = []) {
  const brandSet = new Set((Array.isArray(brandUsers) ? brandUsers : []).map((u) => String(u).toLowerCase()));
  const b = { spend: 0, gross_revenue: 0, orders: 0, clips: 0 };
  const c = { spend: 0, gross_revenue: 0, orders: 0, clips: 0 };
  const creators = new Set();
  for (const r of (Array.isArray(videoRows) ? videoRows : [])) {
    const cost = Number(r.ad_cost) || 0; if (cost <= 0) continue;
    const isBrand = brandSet.has(String(r.username || '').toLowerCase());
    const t = isBrand ? b : c;
    t.spend += cost; t.gross_revenue += Number(r.ad_gross_revenue) || 0; t.orders += Number(r.ad_orders) || 0; t.clips += 1;
    if (!isBrand && r.username) creators.add(String(r.username));
  }
  const fin = (x) => ({ spend: round2(x.spend), gross_revenue: round2(x.gross_revenue), orders: x.orders, clips: x.clips, roi: x.spend > 0 ? round2(x.gross_revenue / x.spend) : 0 });
  return { brand: fin(b), creator: { ...fin(c), creators: creators.size }, clips_total: b.clips + c.clips };
}

async function getRows(cfg, pathAndQuery, fetchImpl) {
  const { status, body } = await dbFetch(cfg, `/rest/v1/${pathAndQuery}`, {}, fetchImpl);
  if (status < 200 || status >= 300 || !Array.isArray(body)) return [];
  return body;
}

// Assemble the whole dashboard DTO for one month, server-side, via the m039_app client.
export async function loadDashboard({ cfg, month, fetchImpl = fetch }) {
  const m = encodeURIComponent(month);
  const BENCHMARK = 3;   // ROI floor placeholder — TODO: confirm Lilsheep's actual owner-set target
  const BRAND_USERS = ['lilsheepcafe'];   // TODO: add Lilsheep's brand TikTok username(s) (vs affiliate creators)
  const [shopMonthly, shopsMeta, adsMonthly, adsItems, gmvmaxMonthly, videoMonthly, affiliateMonthly, affiliateCreators, gmvmaxAll, shopAll, adsAll] = await Promise.all([
    getRows(cfg, `m039_shop_monthly?month=eq.${m}&select=*`, fetchImpl),
    getRows(cfg, `m039_shops?select=key,name`, fetchImpl),
    getRows(cfg, `m039_ads_monthly?month=eq.${m}&select=*`, fetchImpl),
    getRows(cfg, `m039_ads_items?month=eq.${m}&select=*&order=spend.desc`, fetchImpl),
    getRows(cfg, `m039_gmvmax_monthly?month=eq.${m}&select=*`, fetchImpl),
    getRows(cfg, `m039_video_monthly?month=eq.${m}&select=*`, fetchImpl),
    getRows(cfg, `m039_affiliate_monthly?select=*&order=month.desc&limit=12`, fetchImpl),
    getRows(cfg, `m039_affiliate_creators?month=eq.${m}&select=*`, fetchImpl),
    getRows(cfg, `m039_gmvmax_monthly?select=month,promotion_type,cost,gross_revenue,orders&order=month.asc`, fetchImpl),
    getRows(cfg, `m039_shop_monthly?select=month,gmv,orders&order=month.asc`, fetchImpl),
    getRows(cfg, `m039_ads_monthly?select=month,spend,gmv_ads&order=month.asc`, fetchImpl),
  ]);
  const overview = buildOverview(shopMonthly, adsMonthly);
  const gmvmax = buildGmvMax(gmvmaxMonthly);
  const trend = buildTrend(gmvmaxAll, shopAll, adsAll);
  const awareSpend = (adsMonthly || []).filter((a) => (Number(a.gmv_ads) || 0) <= 0).reduce((s, a) => s + (Number(a.spend) || 0), 0);
  const refund = (shopMonthly || []).reduce((s, r) => s + (Number(r.refund) || 0), 0);
  return {
    month,
    benchmark: BENCHMARK,
    overview, gmvmax, trend,
    shops: buildShops(shopMonthly, shopsMeta),
    ads: buildAds(adsMonthly),
    clips: buildClips(adsItems),
    videos: buildVideos(videoMonthly, { benchmark: BENCHMARK }),
    products: buildProducts(videoMonthly),
    adChannels: buildAdChannels(videoMonthly, BRAND_USERS),
    affiliate: buildAffiliate(affiliateMonthly, affiliateCreators, { month }),
    insights: buildInsights({ overview, gmvmax, awareSpend, refund, trend, benchmark: BENCHMARK, month }),
  };
}
