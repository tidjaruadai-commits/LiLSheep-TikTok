import { dbFetch } from './db.js';

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Pure: affiliate video list + live list -> one row per creator (username), split by channel.
// Video rows: {username, gmv{amount}, sku_orders, views}. Live rows: {username, sales_performance{gmv{amount}, sku_orders}}.
export function aggregateCreators(month, videos, lives) {
  const byUser = new Map();
  const get = (u) => {
    let r = byUser.get(u);
    if (!r) { r = { month, username: u, videos: 0, gmv_video: 0, orders_video: 0, views_video: 0, lives: 0, gmv_live: 0, orders_live: 0 }; byUser.set(u, r); }
    return r;
  };
  for (const v of (Array.isArray(videos) ? videos : [])) {
    const u = String(v?.username || ''); if (!u) continue;
    const r = get(u);
    r.videos += 1; r.gmv_video += num(v.gmv && v.gmv.amount); r.orders_video += num(v.sku_orders); r.views_video += num(v.views);
  }
  for (const s of (Array.isArray(lives) ? lives : [])) {
    const u = String(s?.username || ''); if (!u) continue;
    const sp = (s && s.sales_performance) || {};
    const r = get(u);
    r.lives += 1; r.gmv_live += num(sp.gmv && sp.gmv.amount); r.orders_live += num(sp.sku_orders);
  }
  return [...byUser.values()].map((r) => ({ ...r, gmv_video: round2(r.gmv_video), gmv_live: round2(r.gmv_live) }));
}

// Pure: the single per-month growth + carrying-product-count row.
export function mapAffiliateMonthly(month, o) {
  return {
    month,
    gmv_video: round2(o.gmv_video), gmv_live: round2(o.gmv_live),
    orders_video: num(o.orders_video), orders_live: num(o.orders_live),
    video_count: num(o.video_count), live_count: num(o.live_count),
  };
}

async function send(cfg, method, path, rows, extraHeaders, fetchImpl) {
  const opts = { method, headers: { ...(extraHeaders || {}) } };
  if (rows !== undefined) opts.body = JSON.stringify(rows);
  const { status, body } = await dbFetch(cfg, path, opts, fetchImpl);
  if (status < 200 || status >= 300) throw new Error(`${method} ${path} failed (HTTP ${status}) ${JSON.stringify(body).slice(0, 200)}`);
}

// I/O: per month — pull affiliate videos + lives, rank creators, upsert m039_affiliate_creators, and
// upsert the one m039_affiliate_monthly growth row (channel GMV totals + carrying-product counts).
// `creatorTopN` caps stored creators; `videoPages`/`livePages` bound the (non-rate-limited) list paging.
export async function syncAffiliate({ cfg, client, clientId, months, fetchImpl = fetch, creatorTopN = 60, videoPages = 8, livePages = 3 }) {
  const results = [];
  for (const month of months) {
    if (!MONTH_RE.test(month)) { results.push({ month, error: 'bad month' }); continue; }
    try {
      const videos = await client.fetchShopVideos(clientId, month, { accountType: 'AFFILIATE_ACCOUNTS', maxPages: videoPages });
      const lives = await client.fetchShopLives(clientId, month, { accountType: 'AFFILIATE_ACCOUNTS', maxPages: livePages });
      // A successful-but-empty list is a transient blip — skip the whole month so it can never zero the
      // creators OR the growth row (mirrors video-sync's empty guard).
      if (!videos.length && !lives.length) { results.push({ month, creators: 0, skipped: 'no-affiliate-content' }); continue; }

      const stamp = new Date().toISOString();
      const creators = aggregateCreators(month, videos, lives)
        .sort((a, b) => (b.gmv_video + b.gmv_live) - (a.gmv_video + a.gmv_live))
        .slice(0, creatorTopN);
      if (creators.length) {
        await send(cfg, 'POST', '/rest/v1/m039_affiliate_creators?on_conflict=month,username',
          creators.map((r) => ({ ...r, synced_at: stamp })), { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
        // Drop creators that left the top set. Delete by this run's stamp — username is free text, so an
        // in-list filter would be a PostgREST quoting landmine; the rows re-upserted above carry `stamp`.
        await send(cfg, 'DELETE', `/rest/v1/m039_affiliate_creators?month=eq.${month}&synced_at=lt.${encodeURIComponent(stamp)}`, undefined, {}, fetchImpl);
      }

      const [ov, ol, cv, cl] = await Promise.all([
        client.fetchShopOverview(clientId, month, 'videos', { accountType: 'AFFILIATE_ACCOUNTS' }),
        client.fetchShopOverview(clientId, month, 'lives', { accountType: 'AFFILIATE_ACCOUNTS' }),
        client.fetchShopCount(clientId, month, 'videos', { accountType: 'AFFILIATE_ACCOUNTS' }),
        client.fetchShopCount(clientId, month, 'lives', { accountType: 'AFFILIATE_ACCOUNTS' }),
      ]);
      // Only write the growth row when the month has real signal — an all-zero overview is a blip and
      // must not overwrite a good data point.
      if (ov.gmv || ol.gmv || cv || cl) {
        const monthlyRow = mapAffiliateMonthly(month, { gmv_video: ov.gmv, gmv_live: ol.gmv, orders_video: ov.orders, orders_live: ol.orders, video_count: cv, live_count: cl });
        await send(cfg, 'POST', '/rest/v1/m039_affiliate_monthly?on_conflict=month',
          [{ ...monthlyRow, synced_at: stamp }], { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
      }

      results.push({ month, creators: creators.length, ok: true });
    } catch (e) {
      results.push({ month, error: e.message });
    }
  }
  console.log('affiliate-sync:', JSON.stringify({ results }));
  return { ok: results.every((r) => !r.error), results };
}
