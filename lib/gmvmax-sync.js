import { dbFetch } from './db.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Pure: two already-fetched aggregates (LIVE, PRODUCT) -> the two upsert rows for
// m039_gmvmax_monthly (PK: month, advertiser_id, store_id, promotion_type).
export function mapGmvMaxRows(month, advertiserId, storeId, { LIVE, PRODUCT }) {
  const row = (promotionType, agg) => ({
    month, advertiser_id: advertiserId, store_id: storeId, promotion_type: promotionType,
    cost: round2(agg.cost), net_cost: round2(agg.net_cost), gross_revenue: round2(agg.gross_revenue),
    roi: round2(agg.roi), orders: agg.orders || 0,
  });
  return [row('LIVE', LIVE), row('PRODUCT', PRODUCT)];
}

async function send(cfg, method, path, rows, extraHeaders, fetchImpl) {
  const opts = { method, headers: { ...(extraHeaders || {}) } };
  if (rows !== undefined) opts.body = JSON.stringify(rows);
  const { status, body } = await dbFetch(cfg, path, opts, fetchImpl);
  if (status < 200 || status >= 300) throw new Error(`${method} ${path} failed (HTTP ${status}) ${JSON.stringify(body).slice(0, 200)}`);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// I/O: this is Lilsheep's missing "sales ad" data — GMV Max spend/revenue that the normal ads path
// never sees (that one only returns awareness campaigns). Per advertiser: discover its GMV-Max
// enabled stores, then per store x month fetch LIVE + PRODUCT and upsert both rows in one call.
// Every advertiser's store discovery and every (store, month) fetch+upsert is wrapped in its own
// try/catch — one bad advertiser or one stalled store/month never aborts the rest of the sync.
export async function syncGmvMax({ cfg, client, advertiserIds, months, fetchImpl = fetch }) {
  const results = [];
  for (const advertiserId of advertiserIds) {
    let stores;
    try {
      stores = await client.getGmvMaxStores(advertiserId);
    } catch (e) {
      results.push({ advertiserId, error: e.message });
      continue;
    }
    for (const store of (stores || [])) {
      const storeId = String((store && store.store_id) || '');
      if (!storeId) continue;   // defensive: connector already filters to is_gmv_max_available
      for (const month of months) {
        if (!MONTH_RE.test(month)) { results.push({ advertiserId, storeId, month, error: 'bad month' }); continue; }
        try {
          const [LIVE, PRODUCT] = await Promise.all([
            client.fetchGmvMax(advertiserId, storeId, month, 'LIVE'),
            client.fetchGmvMax(advertiserId, storeId, month, 'PRODUCT'),
          ]);
          const rows = mapGmvMaxRows(month, advertiserId, storeId, { LIVE, PRODUCT })
            .map((r) => ({ ...r, synced_at: new Date().toISOString() }));
          await send(cfg, 'POST', '/rest/v1/m039_gmvmax_monthly?on_conflict=month,advertiser_id,store_id,promotion_type',
            rows, { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
          results.push({ advertiserId, storeId, month, ok: true });
        } catch (e) {
          results.push({ advertiserId, storeId, month, error: e.message });
        }
      }
    }
  }
  console.log('gmvmax-sync:', JSON.stringify({ results }));
  return { ok: results.every((r) => !r.error), results };
}
