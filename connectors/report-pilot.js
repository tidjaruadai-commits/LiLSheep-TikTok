// Report Pilot gateway connector. Pure helpers first; the I/O client is added in Task 4.

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM' -> { start (inclusive), end (EXCLUSIVE = 1st of next month) } for /shop-metrics.
export function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return null;
  const y = +m[1], mm = +m[2];
  if (mm < 1 || mm > 12) return null;
  const ny = mm === 12 ? y + 1 : y, nm = mm === 12 ? 1 : mm + 1;
  return { start: `${y}-${pad(mm)}-01`, end: `${ny}-${pad(nm)}-01` };
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// 'YYYY-MM' -> { start_date, end_date } BOTH INCLUSIVE (end = last day of month) for the GMV Max
// report endpoint, which — unlike /shop-metrics's exclusive end — takes an inclusive date range.
export function monthDateRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return null;
  const y = +m[1], mm = +m[2];
  if (mm < 1 || mm > 12) return null;
  const lastDay = mm === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[mm - 1];
  return { start_date: `${y}-${pad(mm)}-01`, end_date: `${y}-${pad(mm)}-${pad(lastDay)}` };
}

// Tokens never contain whitespace; a paste can turn "rpt_" into "rpt ". Repair both.
export function normalizeKey(input) {
  let k = String(input || '').replace(/\s+/g, '');
  if (/^rpt(?!_)/.test(k)) k = 'rpt_' + k.slice(3).replace(/^[_-]+/, '');
  return k;
}

export function looksLikeKey(k) {
  return /^rpt_[A-Za-z0-9_-]{20,}$/.test(String(k || ''));
}

// Distinguish the "no campaigns this month" 422 (skip) from a real 422 (error).
export function classifyAds(status, body) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 422) {
    const msg = (body && (body.detail || body.message || body.error)) || '';
    return /ไม่มีแคมเปญ|no campaigns|no data/i.test(msg) ? 'noData' : 'error';
  }
  return 'error';
}

// `include` parts /shop-metrics accepts — anything else makes the gateway 422. Normalizes
// ' LIVES, products ,x' -> 'products,lives' and '' / unknown-only -> ''.
// `products` is EXPENSIVE: Report Pilot pages through EVERY order of the month just to recover
// product names (5+ minutes on a busy shop — it blew Vercel's 300s function budget before the
// first row was written). So enrichment is strictly opt-in; the default sync asks for nothing.
export const INCLUDE_PARTS = ['products', 'lives'];
export function normalizeInclude(input) {
  const wanted = new Set(String(input || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return INCLUDE_PARTS.filter((p) => wanted.has(p)).join(',');
}

// I/O client. `getKey()` returns the current rpt_ token (from env or the secret store);
// `fetchImpl` is injectable for tests. Only /clients/ is used to discover the client + advertisers
// (the gateway's plural advertiser discovery is rejected for scoped keys).
// `timeoutMs` caps EACH gateway call: a stalled upstream then fails fast (RP_TIMEOUT) and the rest of
// the sync still fits a serverless budget, instead of the whole function being killed mid-fetch.
export function createReportPilotClient({ base = 'https://api.tidjaruad.co', getKey, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const BASE = String(base).replace(/\/+$/, '');
  let clientId = '';

  const signal = () => (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  async function gatewayFetch(url, key, apiPath) {
    try { return await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: signal() }); }
    catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        const e = new Error(`Report Pilot ไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วินาที (${apiPath})`); e.code = 'RP_TIMEOUT'; throw e;
      }
      throw err;
    }
  }

  async function rpFetch(apiPath, params = {}) {
    const key = getKey();
    if (!key) { const e = new Error('ยังไม่ได้เชื่อมต่อ Report Pilot — ใส่ API Token (rpt_...) ก่อน'); e.code = 'NOT_CONNECTED'; throw e; }
    const url = new URL(BASE + apiPath);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const resp = await gatewayFetch(url, key, apiPath);
    if (resp.status === 401 || resp.status === 403) { const e = new Error('Token ไม่ถูกต้องหรือถูกยกเลิก'); e.code = 'RP_AUTH'; throw e; }
    const text = await resp.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (resp.status < 200 || resp.status >= 300) {
      const e = new Error((json && (json.detail || json.message || json.error)) || `Report Pilot error (HTTP ${resp.status})`);
      e.code = 'RP_ERROR'; throw e;
    }
    return json;
  }

  async function getClientId() {
    if (clientId) return clientId;
    const j = await rpFetch('/clients/');
    const list = Array.isArray(j) ? j : (j?.clients || j?.data || []);
    clientId = list[0]?.id || '';
    if (!clientId) { const e = new Error('ไม่พบ client_id จาก Report Pilot'); e.code = 'NO_CLIENT'; throw e; }
    return clientId;
  }

  async function getAdvertiserIds() {
    const j = await rpFetch('/clients/');
    const list = Array.isArray(j) ? j : (j?.clients || j?.data || []);
    const accounts = list[0]?.accounts || [];
    return [...new Set(accounts.map((a) => String(a.advertiser_id || '').trim()).filter(Boolean))];
  }

  // Core numbers only by default (one analytics call, seconds). Pass { include: 'lives' } or
  // 'products,lives' to also get live_sessions / top_products — see normalizeInclude for the cost.
  async function fetchShopMetrics(month, { include = '' } = {}) {
    const range = monthRange(month);
    if (!range) { const e = new Error('เดือนต้องเป็น YYYY-MM'); e.code = 'BAD_MONTH'; throw e; }
    const cid = await getClientId();
    const params = { start: range.start, end: range.end };
    const inc = normalizeInclude(include);
    if (inc) params.include = inc;
    return rpFetch(`/shop-metrics/${cid}`, params);
  }

  async function fetchAdsMetrics(advertiserId, year, month) {
    const key = getKey();
    if (!key) { const e = new Error('ยังไม่ได้เชื่อมต่อ Report Pilot'); e.code = 'NOT_CONNECTED'; throw e; }
    const apiPath = `/ad-accounts/${advertiserId}/metrics`;
    const url = new URL(BASE + apiPath);
    url.searchParams.set('year', String(year));
    url.searchParams.set('month', String(month));
    const resp = await gatewayFetch(url, key, apiPath);
    if (resp.status === 401 || resp.status === 403) { const e = new Error('Token ไม่ถูกต้องหรือถูกยกเลิก'); e.code = 'RP_AUTH'; throw e; }
    const text = await resp.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    const verdict = classifyAds(resp.status, json);
    if (verdict === 'noData') return { noData: true };
    if (verdict === 'error') {
      const e = new Error((json && (json.detail || json.message || json.error)) || `account-metrics error (HTTP ${resp.status})`);
      e.code = 'RP_ERROR'; throw e;
    }
    return json;
  }

  // GMV Max: Lilsheep's "sales ad" data. It goes through the raw gateway proxy (/gateway/ads/<path>)
  // rather than a Report Pilot-shaped endpoint, so the response is TikTok's own {code,message,data}
  // shape — code 0 is success, anything else is a TikTok-side error worth surfacing distinctly.
  const gmvNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const gmvRound2 = (n) => Math.round(n * 100) / 100;

  function ttError(json, fallback) {
    const e = new Error((json && json.message) || fallback);
    e.code = 'TT_ERROR';
    return e;
  }

  // Store discovery: keep only stores TikTok has actually enabled for GMV Max — the report
  // endpoint errors on a store that isn't. NOTE: verified live against the gateway — this
  // endpoint nests results under data.store_list, NOT data.list (that shape belongs to
  // report/get/ below only; the two endpoints do not share a response shape).
  async function getGmvMaxStores(advertiserId) {
    const json = await rpFetch('/gateway/ads/gmv_max/store/list/', { advertiser_id: advertiserId, page_size: 50 });
    if (!json || json.code !== 0) throw ttError(json, 'gmv_max store list error');
    const list = (json.data && json.data.store_list) || [];
    return list.filter((s) => s && s.is_gmv_max_available === true);
  }

  // GMV Max performance for one store/month/promotion type, aggregated across every campaign the
  // report returns. Metric VALUES come back as strings — sum them as numbers; roi is RECOMPUTED
  // from the summed totals (gross_revenue / cost), never averaged from the per-campaign roi strings.
  async function fetchGmvMax(advertiserId, storeId, month, promotionType) {
    const range = monthDateRange(month);
    if (!range) { const e = new Error('เดือนต้องเป็น YYYY-MM'); e.code = 'BAD_MONTH'; throw e; }
    const params = {
      advertiser_id: advertiserId,
      store_ids: JSON.stringify([String(storeId)]),
      start_date: range.start_date,
      end_date: range.end_date,
      dimensions: JSON.stringify(['campaign_id']),
      metrics: JSON.stringify(['cost', 'net_cost', 'gross_revenue', 'roi', 'orders']),
      page_size: 1000,
      filtering: JSON.stringify({ gmv_max_promotion_types: [promotionType] }),
    };
    const json = await rpFetch('/gateway/ads/gmv_max/report/get/', params);
    if (!json || json.code !== 0) throw ttError(json, 'gmv_max report error');
    const list = (json.data && json.data.list) || [];
    let cost = 0, net_cost = 0, gross_revenue = 0, orders = 0;
    for (const row of list) {
      const met = (row && row.metrics) || {};
      cost += gmvNum(met.cost); net_cost += gmvNum(met.net_cost);
      gross_revenue += gmvNum(met.gross_revenue); orders += gmvNum(met.orders);
    }
    return {
      cost: gmvRound2(cost), net_cost: gmvRound2(net_cost), gross_revenue: gmvRound2(gross_revenue),
      roi: cost > 0 ? gmvRound2(gross_revenue / cost) : 0, orders, campaigns: list.length,
    };
  }

  // Complete per-campaign engagement (likes/comments/shares/profile_visits) for a month, straight from
  // TikTok's integrated report via the raw gateway. Unlike the processed feed's top-cost-ads (top-N
  // only), this covers EVERY campaign, so aggregateEngagement can total it accurately per objective.
  // Paged: page_size 1000, loop until page_info.total_page. Metric values arrive as strings — the
  // caller sums them. 15s watch-time isn't a TikTok metric here (only 2s/6s); 15s comes from the
  // processed feed's video_15s instead.
  async function fetchAdReport(advertiserId, month) {
    const range = monthDateRange(month);
    if (!range) { const e = new Error('เดือนต้องเป็น YYYY-MM'); e.code = 'BAD_MONTH'; throw e; }
    const metrics = ['likes', 'comments', 'shares', 'profile_visits'];
    const out = [];
    let page = 1, totalPage = 1;
    do {
      const params = {
        advertiser_id: advertiserId, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN',
        dimensions: JSON.stringify(['campaign_id']), metrics: JSON.stringify(metrics),
        start_date: range.start_date, end_date: range.end_date, page, page_size: 1000,
      };
      const json = await rpFetch('/gateway/ads/report/integrated/get/', params);
      if (!json || json.code !== 0) throw ttError(json, 'ads report error');
      const d = json.data || {};
      for (const row of (d.list || [])) out.push(row);
      totalPage = (d.page_info && d.page_info.total_page) || 1;
      page += 1;
    } while (page <= totalPage);
    return out;
  }

  // Shop-side per-video performance (Seller Center → Analytics → Video): organic + affiliate + ads
  // combined, one row per clip. Paged via next_page_token; the list call is not rate-limited. The API
  // version segment must be 202509 (202406/202409 are deprecated). Dates use the EXCLUSIVE month end.
  async function fetchShopVideos(clientId, month, { accountType = 'ALL', sortField = 'gmv', pageSize = 100, maxPages = 3 } = {}) {
    const range = monthRange(month);
    if (!range) { const e = new Error('เดือนต้องเป็น YYYY-MM'); e.code = 'BAD_MONTH'; throw e; }
    const apiPath = `/gateway/shop/${clientId}/analytics/202509/shop_videos/performance`;
    const out = [];
    let pageToken = '';
    for (let page = 0; page < maxPages; page++) {
      const params = { start_date_ge: range.start, end_date_lt: range.end, page_size: pageSize, sort_field: sortField, sort_order: 'DESC', currency: 'LOCAL', account_type: accountType };
      if (pageToken) params.page_token = pageToken;
      const json = await rpFetch(apiPath, params);
      if (!json || json.code !== 0) throw ttError(json, 'shop_videos list error');
      const data = json.data || {};
      for (const v of (data.videos || [])) out.push(v);
      pageToken = data.next_page_token || '';
      if (!pageToken) break;
    }
    return out;
  }

  // Shop-side per-video ENGAGEMENT (likes/comments/shares/new_followers). This endpoint hits TikTok's
  // shared app-group rate limit, so it retries with a backoff — call it for the top-N clips only.
  async function fetchShopVideoDetail(clientId, videoId, month, { retries = 2, backoffMs = 25000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const range = monthRange(month);
    if (!range) { const e = new Error('เดือนต้องเป็น YYYY-MM'); e.code = 'BAD_MONTH'; throw e; }
    const apiPath = `/gateway/shop/${clientId}/analytics/202509/shop_videos/${videoId}/performance`;
    const params = { start_date_ge: range.start, end_date_lt: range.end, currency: 'LOCAL', granularity: 'ALL' };
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const json = await rpFetch(apiPath, params);
        if (!json || json.code !== 0) throw ttError(json, 'shop_video detail error');
        const ivals = (json.data && json.data.performance && json.data.performance.intervals) || [];
        const t = { views: 0, likes: 0, comments: 0, shares: 0, new_followers: 0 };
        for (const iv of ivals) {
          const tr = (iv && iv.traffic) || {};
          t.views += gmvNum(tr.views); t.likes += gmvNum(tr.likes); t.comments += gmvNum(tr.comments);
          t.shares += gmvNum(tr.shares); t.new_followers += gmvNum(tr.new_followers);
        }
        return t;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) { await sleep(backoffMs); continue; }
        throw e;
      }
    }
    throw lastErr;
  }

  // Ads-side GMV Max ad-attributed per-VIDEO rows (Product GMV Max only). TikTok requires the item
  // level to be scoped by campaign + item_group, so this chains three report calls:
  // campaign_id -> item_group_id (filter by campaigns) -> item_id (filter by campaigns + groups).
  // Returns raw metric strings; the "-1" LIVE bucket is dropped by the caller/mapper.
  async function fetchGmvMaxItems(advertiserId, storeId, month, { topN = 500 } = {}) {
    const range = monthDateRange(month);
    if (!range) { const e = new Error('เดือนต้องเป็น YYYY-MM'); e.code = 'BAD_MONTH'; throw e; }
    const base = { advertiser_id: advertiserId, store_ids: JSON.stringify([String(storeId)]), start_date: range.start_date, end_date: range.end_date, metrics: JSON.stringify(['cost', 'gross_revenue', 'orders']), page_size: 1000 };
    const report = async (dims, extra) => {
      const json = await rpFetch('/gateway/ads/gmv_max/report/get/', { ...base, dimensions: JSON.stringify(dims), ...extra });
      if (!json || json.code !== 0) throw ttError(json, 'gmv_max item report error');
      return (json.data && json.data.list) || [];
    };
    const campaignIds = [...new Set((await report(['campaign_id'])).map((r) => r.dimensions?.campaign_id).filter(Boolean).map(String))];
    if (!campaignIds.length) return [];
    const groupIds = [...new Set((await report(['item_group_id'], { filtering: JSON.stringify({ campaign_ids: campaignIds }) })).map((r) => r.dimensions?.item_group_id).filter(Boolean).map(String))];
    const items = await report(['item_id'], {
      filtering: JSON.stringify({ campaign_ids: campaignIds, item_group_ids: groupIds }),
      metrics: JSON.stringify(['cost', 'gross_revenue', 'roi', 'orders', 'cost_per_order', 'product_impressions', 'product_clicks', 'product_click_rate']),
      sort_field: 'cost', sort_type: 'DESC', enable_total_metrics: true, page_size: Math.min(topN, 1000),
    });
    const out = [];
    for (const r of items) {
      const id = String(r.dimensions?.item_id || '');
      if (!id || id === '-1') continue;
      const m = r.metrics || {};
      out.push({ item_id: id, cost: m.cost, gross_revenue: m.gross_revenue, orders: m.orders });
      if (out.length >= topN) break;
    }
    return out;
  }

  // Shop-side LIVE sessions (Seller Center → Analytics → Live), paged like shop videos. Filter with
  // account_type to isolate affiliate hosts. Rows nest under data.live_stream_sessions.
  async function fetchShopLives(clientId, month, { accountType = 'ALL', sortField = 'gmv', pageSize = 100, maxPages = 3 } = {}) {
    const range = monthRange(month);
    if (!range) { const e = new Error('เดือนต้องเป็น YYYY-MM'); e.code = 'BAD_MONTH'; throw e; }
    const apiPath = `/gateway/shop/${clientId}/analytics/202509/shop_lives/performance`;
    const out = [];
    let pageToken = '';
    for (let page = 0; page < maxPages; page++) {
      const params = { start_date_ge: range.start, end_date_lt: range.end, page_size: pageSize, sort_field: sortField, sort_order: 'DESC', currency: 'LOCAL', account_type: accountType };
      if (pageToken) params.page_token = pageToken;
      const json = await rpFetch(apiPath, params);
      if (!json || json.code !== 0) throw ttError(json, 'shop_lives list error');
      const data = json.data || {};
      for (const s of (data.live_stream_sessions || [])) out.push(s);
      pageToken = data.next_page_token || '';
      if (!pageToken) break;
    }
    return out;
  }

  // Channel totals for the month. kind = 'videos' | 'lives'. Returns { gmv, orders } summed across the
  // performance intervals (one interval when no granularity is requested).
  async function fetchShopOverview(clientId, month, kind, { accountType = 'ALL' } = {}) {
    const range = monthRange(month);
    if (!range) { const e = new Error('เดือนต้องเป็น YYYY-MM'); e.code = 'BAD_MONTH'; throw e; }
    const json = await rpFetch(`/gateway/shop/${clientId}/analytics/202509/shop_${kind}/overview_performance`,
      { start_date_ge: range.start, end_date_lt: range.end, currency: 'LOCAL', account_type: accountType });
    if (!json || json.code !== 0) throw ttError(json, `shop_${kind} overview error`);
    const ivals = (json.data && json.data.performance && json.data.performance.intervals) || [];
    let gmv = 0, orders = 0;
    for (const iv of ivals) { gmv += gmvNum(iv && iv.gmv && iv.gmv.amount); orders += gmvNum(iv && iv.sku_orders); }
    return { gmv: gmvRound2(gmv), orders };
  }

  // total_count for the month = how many videos/lives carried a product (the honest proxy for
  // "creators who attached the product" until the Affiliate Seller scope is granted). kind as above.
  async function fetchShopCount(clientId, month, kind, { accountType = 'ALL' } = {}) {
    const range = monthRange(month);
    if (!range) { const e = new Error('เดือนต้องเป็น YYYY-MM'); e.code = 'BAD_MONTH'; throw e; }
    const json = await rpFetch(`/gateway/shop/${clientId}/analytics/202509/shop_${kind}/performance`,
      { start_date_ge: range.start, end_date_lt: range.end, page_size: 1, sort_field: 'gmv', sort_order: 'DESC', currency: 'LOCAL', account_type: accountType });
    if (!json || json.code !== 0) throw ttError(json, `shop_${kind} count error`);
    return gmvNum(json.data && json.data.total_count);
  }

  return { rpFetch, getClientId, getAdvertiserIds, fetchShopMetrics, fetchAdsMetrics, fetchAdReport, getGmvMaxStores, fetchGmvMax, fetchShopVideos, fetchShopVideoDetail, fetchGmvMaxItems, fetchShopLives, fetchShopOverview, fetchShopCount };
}
