import { dbFetch } from './db.js';

// Pure: Report Pilot /shop-metrics response -> rows for m039_shops + m039_shop_monthly.
// Single-shop client, so shops are keyed by their shop_code (no placeholder juggling).
export function mapShopResponse(month, apiData) {
  const now = new Date().toISOString();
  const shopUpserts = [];
  const monthlyRows = [];
  let synced = 0;
  const apiShops = (apiData?.shops || []);
  apiShops.forEach((sh, i) => {
    if (!sh || sh.error || !sh.metrics || !sh.shop_code) return;
    const code = sh.shop_code;
    const name = (sh.shop_name || code || `ร้าน ${i + 1}`).replace(/\s+/g, ' ').trim();
    shopUpserts.push({ key: code, name, shop_code: code, sort: i });
    const m = sh.metrics || {};
    const ch = m.gmv_by_channel || {};
    const row = {
      month, shop_key: code,
      gmv: m.gmv || 0, refund: m.refunds || 0, orders: m.orders || 0, units: m.units || 0,
      gmv_live: ch.live || 0, gmv_video: ch.video || 0, gmv_product_card: ch.product_card || 0,
      visitors: m.visitors || 0, page_views: m.page_views || 0, gross_revenue: m.gross_revenue || 0,
      synced_at: now,
    };
    if (Array.isArray(sh.top_products)) row.top_products = sh.top_products;
    if (Array.isArray(sh.live_sessions)) row.live_sessions = sh.live_sessions;
    monthlyRows.push(row);
    synced++;
  });
  const errShops = apiShops.filter((s) => s && s.error).length;
  const failed = Number(apiData?.total?.shops_failed ?? errShops);
  return { shopUpserts, monthlyRows, synced, failed };
}

async function upsert(cfg, table, rows, onConflict, fetchImpl) {
  if (!rows.length) return;
  const { status, body } = await dbFetch(cfg, `/rest/v1/${table}?on_conflict=${onConflict}`,
    { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) }, fetchImpl);
  if (status < 200 || status >= 300) throw new Error(`write ${table} failed (HTTP ${status}) ${JSON.stringify(body).slice(0, 200)}`);
}

// I/O: fetch one month of shop metrics via the connector and upsert m039_shops + m039_shop_monthly.
// `include` ('' | 'lives' | 'products,lives') is opt-in enrichment — the default light sync never
// sends it, and because mapShopResponse omits top_products/live_sessions when absent, a light sync
// never overwrites enrichment a previous heavy sync stored (upsert only touches the keys sent).
export async function syncShopMetrics({ cfg, client, month, include = '', fetchImpl = fetch }) {
  const apiData = await client.fetchShopMetrics(month, { include });
  const { shopUpserts, monthlyRows, synced, failed } = mapShopResponse(month, apiData);
  await upsert(cfg, 'm039_shops', shopUpserts, 'key', fetchImpl);            // parent first (FK)
  await upsert(cfg, 'm039_shop_monthly', monthlyRows, 'month,shop_key', fetchImpl);
  console.log('shop-sync:', JSON.stringify({ month, include, synced, failed }));
  return { ok: true, month, include, synced, failed };
}
