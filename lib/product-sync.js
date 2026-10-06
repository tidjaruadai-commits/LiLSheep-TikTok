import { dbFetch } from './db.js';
import { TIKTOK_OUTSIDE_LOOKBACK } from '../connectors/report-pilot.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Pure: readShopProduct() rows -> m039_product_monthly rows. One row per product id; a missing
// gmv/orders/items_sold is 0 (readShopProduct leaves it null so a whole page of nulls can be refused
// upstream — by the time a page gets here at least one row had a readable GMV).
export function mapProducts(month, products) {
  const seen = new Set();
  const rows = [];
  for (const p of (Array.isArray(products) ? products : [])) {
    const id = String((p && p.id) || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      month, product_id: id, name: p.name || '',
      gmv: round2(p.gmv), orders: Math.round(Number(p.orders) || 0), items_sold: Math.round(Number(p.items_sold) || 0),
    });
  }
  return rows;
}

async function send(cfg, method, path, rows, extraHeaders, fetchImpl) {
  const opts = { method, headers: { ...(extraHeaders || {}) } };
  if (rows !== undefined) opts.body = JSON.stringify(rows);
  const { status, body } = await dbFetch(cfg, path, opts, fetchImpl);
  if (status < 200 || status >= 300) throw new Error(`${method} ${path} failed (HTTP ${status}) ${JSON.stringify(body).slice(0, 200)}`);
}

// I/O: per month — pull the shop's per-product sales (all channels) and upsert m039_product_monthly.
// Cheap (a couple of list calls), so the controller runs it before the heavier per-clip sync.
export async function syncProducts({ cfg, client, clientId, months, fetchImpl = fetch }) {
  const results = [];
  for (const month of months) {
    if (!MONTH_RE.test(month)) { results.push({ month, error: 'bad month' }); continue; }
    try {
      const { products, version, truncated } = await client.fetchShopProducts(clientId, month);
      // A successful-but-empty list is a transient blip. Skip the month entirely so it can never
      // delete the products an earlier run stored (mirrors video-sync / affiliate-sync).
      if (!products.length) { results.push({ month, products: 0, skipped: 'no-products' }); continue; }

      const stamp = new Date().toISOString();
      const rows = mapProducts(month, products);
      await send(cfg, 'POST', '/rest/v1/m039_product_monthly?on_conflict=month,product_id',
        rows.map((r) => ({ ...r, synced_at: stamp })), { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
      // Drop products no longer returned. Delete by this run's stamp — names are free text, so an
      // in-list filter would be a PostgREST quoting landmine; the rows upserted above carry `stamp`.
      await send(cfg, 'DELETE', `/rest/v1/m039_product_monthly?month=eq.${month}&synced_at=lt.${encodeURIComponent(stamp)}`, undefined, {}, fetchImpl);

      results.push({ month, products: rows.length, gmv: round2(rows.reduce((s, r) => s + r.gmv, 0)), version, ...(truncated ? { truncated: true } : {}), ok: true });
    } catch (e) {
      // Past TikTok's ~180-day analytics wall there is nothing to fetch and never will be — a
      // boundary, not a failure (same guard as video-sync / affiliate-sync).
      if (e && e.ttCode === TIKTOK_OUTSIDE_LOOKBACK) results.push({ month, skipped: 'outside-tiktok-window' });
      else results.push({ month, error: e.message });
    }
  }
  console.log('product-sync:', JSON.stringify({ results }));
  return { ok: results.every((r) => !r.error), results };
}
