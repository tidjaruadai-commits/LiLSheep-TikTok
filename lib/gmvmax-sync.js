import { dbFetch } from './db.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const PROMOTION_TYPES = ['LIVE', 'PRODUCT'];

// Pure: the already-fetched aggregates -> the upsert rows for m039_gmvmax_monthly
// (PK: month, advertiser_id, store_id, promotion_type). A type that is absent from
// `aggregates` yields no row: the row is left as it was rather than overwritten with
// a number nobody fetched. `fetchGmvMax` returns zeros when a type genuinely had no
// campaigns, so absent here only ever means "the call failed".
export function mapGmvMaxRows(month, advertiserId, storeId, aggregates) {
  const row = (promotionType, agg) => ({
    month, advertiser_id: advertiserId, store_id: storeId, promotion_type: promotionType,
    cost: round2(agg.cost), net_cost: round2(agg.net_cost), gross_revenue: round2(agg.gross_revenue),
    roi: round2(agg.roi), orders: agg.orders || 0,
  });
  return PROMOTION_TYPES.filter((t) => aggregates && aggregates[t]).map((t) => row(t, aggregates[t]));
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
          // allSettled, not all: the two calls are independent, and the gateway can fail one
          // of them on its own (a dead pooled Supabase connection gives an intermittent 500).
          // Promise.all would reject on that and throw away the type that DID come back —
          // which is how a month of Lilsheep GMV Max ended up never written at all.
          const settled = await Promise.allSettled(PROMOTION_TYPES.map(
            (t) => client.fetchGmvMax(advertiserId, storeId, month, t)));
          const aggregates = {};
          const failures = [];
          PROMOTION_TYPES.forEach((t, i) => {
            if (settled[i].status === 'fulfilled') aggregates[t] = settled[i].value;
            else failures.push(`${t}: ${(settled[i].reason && settled[i].reason.message) || settled[i].reason}`);
          });
          const rows = mapGmvMaxRows(month, advertiserId, storeId, aggregates)
            .map((r) => ({ ...r, synced_at: new Date().toISOString() }));
          if (!rows.length) throw new Error(failures.join('; ') || 'no gmv max rows to write');
          await send(cfg, 'POST', '/rest/v1/m039_gmvmax_monthly?on_conflict=month,advertiser_id,store_id,promotion_type',
            rows, { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
          // A partial write still counts as an error so the run reports failure and the next
          // one retries the missing type — but the half that worked is already saved.
          if (failures.length) results.push({ advertiserId, storeId, month, wrote: rows.map((r) => r.promotion_type), error: failures.join('; ') });
          else results.push({ advertiserId, storeId, month, ok: true });
        } catch (e) {
          results.push({ advertiserId, storeId, month, error: e.message });
        }
      }
    }
  }
  console.log('gmvmax-sync:', JSON.stringify({ results }));
  return { ok: results.every((r) => !r.error), results };
}
