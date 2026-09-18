import { dbFetch } from './db.js';

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

const round2 = (n) => Math.round(n * 100) / 100;

// Pure: processed account-metrics -> rows for m039_ads_monthly (ONE row per campaign_type) +
// m039_ads_items (per clip, deduped by ad_id). Labels come from results_by_type, matched on `type`.
// Report Pilot can return several projects with the same campaign_type; m039_ads_monthly's PK is
// (month, advertiser_id, campaign_type), so they are SUMMED into one row — duplicate keys inside a
// single upsert make Postgres reject the whole batch (21000), which is exactly what happened live.
export function mapAdsResponse(month, advertiserId, data) {
  const labelByType = {};
  (data?.results_by_type || []).forEach((rt) => { if (rt && rt.type != null) labelByType[String(rt.type)] = rt.label; });
  const byType = new Map();
  const adRows = [];
  const seen = new Set();
  for (const p of (Array.isArray(data?.projects) ? data.projects : [])) {
    const ctype = p.campaign_type == null ? 'unknown' : p.campaign_type;   // column is NOT NULL
    const label = labelByType[String(ctype)] || p.project_name || '';
    let row = byType.get(String(ctype));
    if (!row) {
      row = { month, advertiser_id: advertiserId, campaign_type: ctype, spend: 0, impressions: 0, clicks: 0,
        results: 0, result_label: label, engagement: 0, video_views: 0, gmv_ads: 0,
        video_6s: 0, video_15s: 0, video_completed: 0,
        // filled later per objective from the raw integrated report (mergeEngagement); the processed
        // feed only gives a combined `engagement`, never the like/comment/share/profile split.
        likes: 0, comments: 0, shares: 0, profile_visits: 0 };
      byType.set(String(ctype), row);
    }
    row.spend += num(p.spend); row.impressions += num(p.impressions); row.clicks += num(p.clicks);
    row.results += num(p.results); row.engagement += num(p.engagement);
    row.video_views += num(p.video_views); row.gmv_ads += num(p.onsite_gmv);
    row.video_6s += num(p.video_6s); row.video_15s += num(p.video_15s); row.video_completed += num(p.video_completed);
    for (const ad of (p.top_cost_ads || [])) {
      const adId = String(ad.ad_id || '');
      if (!adId || seen.has(adId)) continue;
      seen.add(adId);
      adRows.push({
        month, advertiser_id: advertiserId, ad_id: adId,
        ad_name: ad.ad_name || '', caption: ad.caption || '', campaign_type: ctype,
        cover_url: ad.thumbnail_url || '', video_url: ad.video_url || '',
        spend: num(ad.spend), impressions: num(ad.impressions), clicks: num(ad.clicks),
        results: num(ad.results), result_label: label,
        engagement: num(ad.like) + num(ad.comment) + num(ad.share) + num(ad.follow) + num(ad.favorite) + num(ad.profile_visit),
        video_views: num(ad.video_views), deep_score: num(ad.deep_score), gmv: num(ad.onsite_gmv),
      });
    }
  }
  const monthlyRows = [...byType.values()].map((r) => ({ ...r, spend: round2(r.spend), gmv_ads: round2(r.gmv_ads) }));
  return { monthlyRows, adRows };
}

// Pure: campaign_id -> objective (campaign_type), read from the processed response's per-objective
// `campaigns` lists. This is the COMPLETE mapping (every campaign, not just top-cost ads), which is
// what lets us fold the raw report's per-campaign engagement back into the right objective bucket.
export function campaignTypeMap(data) {
  const map = {};
  for (const p of (Array.isArray(data?.projects) ? data.projects : [])) {
    const t = p.campaign_type == null ? 'unknown' : p.campaign_type;
    for (const c of (Array.isArray(p.campaigns) ? p.campaigns : [])) {
      const id = c && (c.campaign_id ?? c.id);
      if (id != null) map[String(id)] = t;
    }
  }
  return map;
}

// Pure: rows from the raw integrated report (per campaign_id) -> per-objective engagement totals.
// The processed feed only exposes a combined `engagement`; this is the only way to get the real
// per-objective like/comment/share/profile-visit split, complete across ALL campaigns (not top ads).
export function aggregateEngagement(reportRows, typeMap = {}) {
  const out = {};
  for (const r of (Array.isArray(reportRows) ? reportRows : [])) {
    const id = String((r && r.dimensions && r.dimensions.campaign_id) ?? '');
    const t = typeMap[id];
    if (!t) continue;   // a campaign not in this month's objectives — ignore
    const m = (r && r.metrics) || {};
    const b = out[t] || (out[t] = { likes: 0, comments: 0, shares: 0, profile_visits: 0 });
    b.likes += num(m.likes); b.comments += num(m.comments); b.shares += num(m.shares); b.profile_visits += num(m.profile_visits);
  }
  return out;
}

// Pure: fold per-objective engagement totals into the monthly rows by campaign_type. A row whose
// objective has no report data keeps its seeded zeros — never nulled — so a report hiccup can only
// leave the split at 0, never corrupt the core row.
export function mergeEngagement(monthlyRows, engagementByType = {}) {
  return (Array.isArray(monthlyRows) ? monthlyRows : []).map((r) => {
    const e = engagementByType && engagementByType[r.campaign_type];
    return e ? { ...r, likes: e.likes, comments: e.comments, shares: e.shares, profile_visits: e.profile_visits } : r;
  });
}

// Pure: a re-sync must not undo the cover archive. Report Pilot sends a fresh (expiring) CDN
// thumbnail on every run; when we already hold a stable m039-covers copy for that ad, keep ours —
// otherwise every daily run re-downloads every clip and burns the whole function budget.
export function keepArchivedCovers(adRows, existingRows) {
  const archived = new Map();
  for (const r of (Array.isArray(existingRows) ? existingRows : [])) {
    if (r && r.ad_id && /\/m039-covers\//.test(String(r.cover_url || ''))) archived.set(String(r.ad_id), r.cover_url);
  }
  return adRows.map((r) => (archived.has(r.ad_id) ? { ...r, cover_url: archived.get(r.ad_id) } : r));
}

async function send(cfg, method, path, rows, extraHeaders, fetchImpl) {
  const opts = { method, headers: { ...(extraHeaders || {}) } };
  if (rows !== undefined) opts.body = JSON.stringify(rows);
  const { status, body } = await dbFetch(cfg, path, opts, fetchImpl);
  if (status < 200 || status >= 300) throw new Error(`${method} ${path} failed (HTTP ${status}) ${JSON.stringify(body).slice(0, 200)}`);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;   // guards the PostgREST filter interpolation below

// I/O: per advertiser per month — provision the account, skip noData, upsert monthly, replace items.
export async function syncAds({ cfg, client, advertiserIds, months, fetchImpl = fetch }) {
  const results = [];
  for (const advertiserId of advertiserIds) {
    const adv = encodeURIComponent(String(advertiserId));
    for (const month of months) {
      if (!MONTH_RE.test(month)) { results.push({ advertiserId, month, error: 'bad month' }); continue; }
      try {
        const [y, m] = month.split('-').map(Number);
        const data = await client.fetchAdsMetrics(advertiserId, y, m);
        await send(cfg, 'POST', '/rest/v1/m039_ad_accounts?on_conflict=advertiser_id',
          [{ advertiser_id: advertiserId, name: (data && data.client_name) || advertiserId, sort: 0 }],
          { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
        if (!data || data.noData) { results.push({ advertiserId, month, skipped: 'no-data' }); continue; }
        const { monthlyRows, adRows } = mapAdsResponse(month, advertiserId, data);
        // Enrich each objective with its COMPLETE like/comment/share/profile-visit split from the raw
        // integrated report (the processed feed only gives a combined `engagement`). Isolated: a report
        // failure logs and leaves the split at its seeded 0, never blocking the core objective upsert.
        let engRows = monthlyRows;
        try {
          const reportRows = await client.fetchAdReport(advertiserId, month);
          engRows = mergeEngagement(monthlyRows, aggregateEngagement(reportRows, campaignTypeMap(data)));
        } catch (e) { console.log('ads-report:', JSON.stringify({ advertiserId, month, error: e.message })); }
        if (engRows.length) await send(cfg, 'POST', '/rest/v1/m039_ads_monthly?on_conflict=month,advertiser_id,campaign_type',
          engRows, { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
        if (adRows.length) {
          const existing = await dbFetch(cfg,
            `/rest/v1/m039_ads_items?month=eq.${month}&advertiser_id=eq.${adv}&select=ad_id,cover_url&cover_url=like.*m039-covers*`, {}, fetchImpl);
          const itemRows = keepArchivedCovers(adRows, existing.status === 200 ? existing.body : []);
          await send(cfg, 'POST', '/rest/v1/m039_ads_items?on_conflict=month,advertiser_id,ad_id',
            itemRows, { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
        }
        const ids = adRows.map((r) => encodeURIComponent(r.ad_id)).join(',');
        const stale = ids
          ? `/rest/v1/m039_ads_items?month=eq.${month}&advertiser_id=eq.${adv}&ad_id=not.in.(${ids})`
          : `/rest/v1/m039_ads_items?month=eq.${month}&advertiser_id=eq.${adv}`;
        await send(cfg, 'DELETE', stale, undefined, {}, fetchImpl);
        results.push({ advertiserId, month, monthly: monthlyRows.length, items: adRows.length });
      } catch (e) {
        results.push({ advertiserId, month, error: e.message });
      }
    }
  }
  console.log('ads-sync:', JSON.stringify({ results }));
  return { ok: results.every((r) => !r.error), results };
}
