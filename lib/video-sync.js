import { dbFetch } from './db.js';

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Pure: shop_videos list rows (TikTok values arrive as strings) -> m039_video_monthly base rows.
// gmv/gpm are money (rounded); orders/items_sold/views are counts; ctr is a rate (kept as-is).
export function mapShopVideos(month, videos) {
  const seen = new Set();
  const rows = [];
  for (const v of (Array.isArray(videos) ? videos : [])) {
    const id = String(v?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      month, video_id: id,
      title: v.title || '', username: v.username || '',
      product: (Array.isArray(v.products) && v.products[0]?.name) || '',
      post_time: v.video_post_time || '',
      gmv: round2(num(v.gmv?.amount)), orders: num(v.sku_orders), items_sold: num(v.items_sold),
      views: num(v.views), ctr: num(v.click_through_rate), gpm: round2(num(v.gpm?.amount)),
    });
  }
  return rows;
}

// Pure: attach GMV Max ad-attributed per-clip cost/revenue/orders by item_id (== shop video id).
// item_id "-1" is the LIVE GMV Max bucket (no per-clip breakdown) — skipped. roi is RECOMPUTED from
// the summed totals, never taken from TikTok's roi string. A GMV Max item with no matching shop
// video still becomes a row (title unknown) so a high-ROI clip is never dropped.
export function mergeAdItems(month, videoRows, adItems) {
  const byId = new Map();
  const out = (Array.isArray(videoRows) ? videoRows : []).map((r) => {
    const row = { ...r, ad_cost: null, ad_gross_revenue: null, ad_orders: null, ad_roi: null };
    byId.set(row.video_id, row);
    return row;
  });
  for (const it of (Array.isArray(adItems) ? adItems : [])) {
    const id = String(it?.item_id || '');
    if (!id || id === '-1') continue;
    let row = byId.get(id);
    if (!row) {
      row = { month, video_id: id, title: '', username: '', product: '', post_time: '',
        gmv: 0, orders: 0, items_sold: 0, views: 0, ctr: 0, gpm: 0, ad_cost: 0, ad_gross_revenue: 0, ad_orders: 0, ad_roi: 0 };
      byId.set(id, row); out.push(row);
    }
    // SUM across advertisers/stores — the same clip can appear under more than one account — then
    // recompute roi from the summed totals, never keep the last slice's roi.
    const cost = round2((Number(row.ad_cost) || 0) + round2(num(it.cost)));
    const rev = round2((Number(row.ad_gross_revenue) || 0) + round2(num(it.gross_revenue)));
    row.ad_cost = cost; row.ad_gross_revenue = rev;
    row.ad_orders = (Number(row.ad_orders) || 0) + num(it.orders);
    row.ad_roi = cost > 0 ? round2(rev / cost) : 0;
  }
  return out;
}

// Pure: attach per-clip likes/comments/shares/new_followers from the detail endpoint. Only the top-N
// clips are fetched, so a clip with no detail leaves them null (so the UI can tell "0" from "not measured").
export function mergeEngagement(videoRows, detailById) {
  const d = detailById || {};
  return (Array.isArray(videoRows) ? videoRows : []).map((r) => {
    const det = d[r.video_id];
    return {
      ...r,
      likes: det ? num(det.likes) : null,
      comments: det ? num(det.comments) : null,
      shares: det ? num(det.shares) : null,
      new_followers: det ? num(det.new_followers) : null,
    };
  });
}

// Pure: the detail endpoint's rate limit means only a few clips get engagement each run. A blind
// upsert would null out the engagement earlier runs measured. So carry forward the stored values for
// any clip this run did not re-measure — engagement then accumulates across daily runs.
export function keepEngagement(rows, existingRows) {
  const prior = new Map();
  for (const r of (Array.isArray(existingRows) ? existingRows : [])) {
    if (r && r.video_id != null && r.likes != null) prior.set(String(r.video_id), r);
  }
  return (Array.isArray(rows) ? rows : []).map((r) => {
    if (r.likes != null) return r;                       // measured this run — keep the fresh values
    const p = prior.get(String(r.video_id));
    return p ? { ...r, likes: p.likes, comments: p.comments, shares: p.shares, new_followers: p.new_followers } : r;
  });
}

// Pure: the public TikTok watch URL for a clip (username + video id). Both are needed.
export function clipUrl(username, videoId) {
  const u = String(username || ''), id = String(videoId || '');
  return (u && id) ? `https://www.tiktok.com/@${u}/video/${id}` : '';
}

// I/O (best-effort): the clip's cover thumbnail via TikTok's public oembed endpoint (NOT the gateway —
// no auth, different host, so it does not touch the Shop API rate limit). Returns null on any failure.
export async function fetchOembedThumbnail(username, videoId, fetchImpl = fetch, timeoutMs = 8000) {
  const url = clipUrl(username, videoId);
  if (!url) return null;
  try {
    const signal = (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(timeoutMs) : undefined;   // a stalled oembed connection can't hang the sync
    const resp = await fetchImpl('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal });
    if (!resp || resp.status < 200 || resp.status >= 300) return null;
    const j = await resp.json();
    const t = j && j.thumbnail_url;
    return (typeof t === 'string' && /^https:\/\//.test(t)) ? t : null;
  } catch { return null; }
}

// Pure: carry a stored cover forward when this run didn't fetch one (oembed is best-effort + rate-shy),
// so covers accumulate across daily syncs. Normalizes a missing cover to null.
export function keepCovers(rows, existingRows) {
  const prior = new Map();
  for (const r of (Array.isArray(existingRows) ? existingRows : [])) {
    if (r && r.video_id != null && r.cover_url) prior.set(String(r.video_id), r.cover_url);
  }
  return (Array.isArray(rows) ? rows : []).map((r) => (r.cover_url ? r : { ...r, cover_url: prior.get(String(r.video_id)) || null }));
}

async function send(cfg, method, path, rows, extraHeaders, fetchImpl) {
  const opts = { method, headers: { ...(extraHeaders || {}) } };
  if (rows !== undefined) opts.body = JSON.stringify(rows);
  const { status, body } = await dbFetch(cfg, path, opts, fetchImpl);
  if (status < 200 || status >= 300) throw new Error(`${method} ${path} failed (HTTP ${status}) ${JSON.stringify(body).slice(0, 200)}`);
}

// I/O: per month — pull shop videos, join GMV Max per-clip ads (per advertiser/store) and engagement
// (top-N only, rate-limit-prone so best-effort/isolated), then upsert m039_video_monthly and drop stale.
export async function syncVideos({ cfg, client, clientId, advertiserIds = [], months, fetchImpl = fetch, detailTopN = 10, detailBudgetMs = Infinity, now = () => Date.now(), sleep, fetchCover = fetchOembedThumbnail, coverTopN = 40, coverBudgetMs = 30_000 }) {
  const results = [];
  for (const month of months) {
    if (!MONTH_RE.test(month)) { results.push({ month, error: 'bad month' }); continue; }
    try {
      const videos = await client.fetchShopVideos(clientId, month, { accountType: 'ALL' });
      // An empty (but successful) response is a transient blip / empty page — never proof the month has
      // no clips. Skip the whole write phase so a blip can never delete a month's rows + engagement.
      if (!videos.length) { results.push({ month, videos: 0, skipped: 'no-videos' }); continue; }
      let rows = mapShopVideos(month, videos);

      // GMV Max ad-attributed per-clip — isolate per advertiser so one bad account never loses the month.
      const adItems = [];
      const adWarnings = [];
      for (const adv of advertiserIds) {
        try {
          const stores = await client.getGmvMaxStores(adv);
          for (const s of (stores || [])) {
            const storeId = s && s.store_id;
            if (!storeId) continue;
            const items = await client.fetchGmvMaxItems(adv, storeId, month);
            if (Array.isArray(items)) adItems.push(...items);
          }
        } catch (e) { adWarnings.push(`${adv}: ${e.message}`); }
      }
      rows = mergeAdItems(month, rows, adItems);

      // Engagement for the top-N clips by views. The detail endpoint hits TikTok's shared rate limit,
      // so each call is isolated and its failure only means "engagement not measured" for that clip.
      const top = [...rows].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, detailTopN);
      const detailById = {};
      const detailStart = now();
      for (const v of top) {
        // Bounded per clip (low retries + short backoff) so one rate-limited clip can't, on its own,
        // consume the whole serverless budget between two budget checks.
        try { detailById[v.video_id] = await client.fetchShopVideoDetail(clientId, v.video_id, month, { sleep, retries: 1, backoffMs: 10000 }); }
        catch { /* best-effort: skip this clip's engagement */ }
        if (now() - detailStart > detailBudgetMs) break;   // never let the rate-limit backoff blow the serverless budget
      }
      rows = mergeEngagement(rows, detailById);

      // Covers: fetch the TikTok oembed thumbnail for clips that can appear in a leaderboard (top by
      // views + the ad-spent sales clips). Best-effort, time-budgeted, and accumulated via keepCovers.
      const coverSet = new Map();
      for (const r of [...rows].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, coverTopN)) coverSet.set(r.video_id, r);
      for (const r of rows.filter((r) => Number(r.ad_cost) > 0).sort((a, b) => (b.ad_gross_revenue || 0) - (a.ad_gross_revenue || 0)).slice(0, 20)) coverSet.set(r.video_id, r);
      const coverStart = now();
      for (const r of coverSet.values()) {
        if (now() - coverStart > coverBudgetMs) break;
        const c = await fetchCover(r.username, r.video_id);
        if (c) r.cover_url = c;
      }

      // Recover engagement + covers measured on earlier runs (this run only re-fetched the top-N). If
      // this read fails we must NOT proceed — a null-carrying upsert would wipe stored engagement/covers.
      const existing = await dbFetch(cfg, `/rest/v1/m039_video_monthly?month=eq.${month}&select=video_id,likes,comments,shares,new_followers,cover_url`, {}, fetchImpl);
      if (existing.status < 200 || existing.status >= 300 || !Array.isArray(existing.body)) {
        throw new Error(`recovery read failed (HTTP ${existing.status}) — skipped write to protect stored engagement/covers`);
      }
      rows = keepEngagement(rows, existing.body);
      rows = keepCovers(rows, existing.body);

      // Only ever a FILTERED delete (drop clips that left the tracked set); never the unfiltered
      // month wipe. rows is non-empty here (guarded above), so ids is always present.
      const ids = rows.map((r) => encodeURIComponent(r.video_id)).join(',');
      if (ids) {
        const stamp = new Date().toISOString();
        await send(cfg, 'POST', '/rest/v1/m039_video_monthly?on_conflict=month,video_id',
          rows.map((r) => ({ ...r, synced_at: stamp })), { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
        await send(cfg, 'DELETE', `/rest/v1/m039_video_monthly?month=eq.${month}&video_id=not.in.(${ids})`, undefined, {}, fetchImpl);
      }
      results.push({ month, videos: rows.length, ok: true, ...(adWarnings.length ? { adWarnings } : {}) });
    } catch (e) {
      results.push({ month, error: e.message });
    }
  }
  console.log('video-sync:', JSON.stringify({ results }));
  return { ok: results.every((r) => !r.error), results };
}
