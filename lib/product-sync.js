import { dbFetch, buildHeaders } from './db.js';
import { TIKTOK_OUTSIDE_LOOKBACK, TIKTOK_APP_GROUP_RATE_LIMIT } from '../connectors/report-pilot.js';

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

// The image URL comes from TikTok's API response, and this server downloads it. Public https only:
// no bare IPs, no localhost or internal-looking hosts, so a bad response can never aim the download
// at something inside our own network.
export function isPublicHttps(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (!h.includes('.') || /^\d+(\.\d+){3}$/.test(h) || h.startsWith('[')) return false;
    return !(h === 'localhost' || /\.(local|internal|localhost)$/.test(h));
  } catch { return false; }
}

// I/O: give products that have no picture yet one. TikTok's image URLs are signed and expire within
// days, so the picture is copied into our public m039-covers bucket at once (the URL is fresh) and
// only OUR url is stored — the same reason cover-archive exists. A product that already has a row is
// never fetched again. Best-effort by design: a missing picture must never fail a sales sync, so
// problems come back as a count and the first reason, not a throw.
//   - budgetMs: stop starting new products once spent; the next run carries on (remaining says how many).
//   - the app-group rate limit stops the loop (waiting inside one run only spends the exhausted quota).
//   - maxFailuresInARow: a missing API scope fails every product the same way, so give up early and say why.
export async function syncProductImages({ cfg, client, clientId, products, fetchImpl = fetch, budgetMs = 40_000, maxFailuresInARow = 3, now = () => Date.now() }) {
  const started = now();
  const bucket = cfg.coversBucket || 'm039-covers';
  const have = await dbFetch(cfg, '/rest/v1/m039_product_images?select=product_id&limit=5000', {}, fetchImpl);
  if (have.status < 200 || have.status >= 300 || !Array.isArray(have.body)) return { error: `อ่านตารางรูปสินค้าไม่ได้ (HTTP ${have.status})` };
  const haveIds = new Set(have.body.map((r) => String(r.product_id)));
  // Ids are digits; anything else is skipped rather than interpolated into a URL path.
  const missing = (Array.isArray(products) ? products : []).filter((p) => p && /^\d+$/.test(String(p.id)) && !haveIds.has(String(p.id)));

  let fetched = 0, noImage = 0, failed = 0, inARow = 0, processed = 0, error = '', stopped = '';
  for (const p of missing) {
    if (now() - started >= budgetMs) { stopped = 'budget'; break; }
    processed++;
    try {
      const { url } = await client.fetchProductImage(clientId, String(p.id));
      if (!url) { noImage++; inARow = 0; continue; }   // a product with no picture is normal
      if (!isPublicHttps(url)) throw new Error('image url ไม่ใช่ https สาธารณะ');
      const img = await fetchImpl(url);
      if (!img.status || img.status < 200 || img.status >= 300) throw new Error(`โหลดรูปไม่ได้ (HTTP ${img.status})`);
      const type = (img.headers && img.headers.get && img.headers.get('content-type')) || 'image/jpeg';
      if (!/^image\//i.test(type)) throw new Error(`ได้ไฟล์ที่ไม่ใช่รูป (${type})`);
      const buf = Buffer.from(await img.arrayBuffer());
      const name = `products/${p.id}.jpg`;
      const up = await fetchImpl(`${cfg.supabaseUrl}/storage/v1/object/${bucket}/${name}`, {
        method: 'POST', headers: { ...buildHeaders(cfg), 'Content-Type': type, 'x-upsert': 'true' }, body: buf,
      });
      if (up.status < 200 || up.status >= 300) throw new Error(`เก็บรูปลง bucket ไม่ได้ (HTTP ${up.status})`);
      await send(cfg, 'POST', '/rest/v1/m039_product_images?on_conflict=product_id',
        [{ product_id: String(p.id), image_url: `${cfg.supabaseUrl}/storage/v1/object/public/${bucket}/${name}`, updated_at: new Date().toISOString() }],
        { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
      fetched++; inARow = 0;
    } catch (e) {
      failed++; inARow++;
      if (!error) error = e.message;
      if (e && e.ttCode === TIKTOK_APP_GROUP_RATE_LIMIT) { stopped = 'rate-limit'; break; }
      if (inARow >= maxFailuresInARow) { stopped = 'failures'; break; }
    }
  }
  return {
    withImage: haveIds.size + fetched, missing: missing.length, fetched, noImage, failed,
    remaining: missing.length - processed,
    ...(stopped ? { stopped } : {}), ...(error ? { error } : {}),
  };
}

// Pure: shop_videos rows list their products as { id, name } -> { [id]: name }. First non-empty name
// wins; ids are kept as their exact text (parseJsonExact keeps 19-digit ids exact upstream).
export function namesFromVideos(videos) {
  const out = {};
  for (const v of (Array.isArray(videos) ? videos : [])) {
    for (const p of ((v && Array.isArray(v.products)) ? v.products : [])) {
      const id = String((p && p.id) ?? '').trim();
      const name = String((p && p.name) ?? '').replace(/\s+/g, ' ').trim();
      if (/^\d+$/.test(id) && name && !out[id]) out[id] = name;
    }
  }
  return out;
}

// I/O: the per-product sales list carries no names, so name the month's products from the shop video
// list, keeping every name it finds (they serve every month). Only calls TikTok when this month has a
// product with no name yet. Best-effort like the pictures: a failure is reported, never thrown.
export async function syncProductNames({ cfg, client, clientId, month, products, fetchImpl = fetch, videoPages = 5 }) {
  const have = await dbFetch(cfg, '/rest/v1/m039_product_names?select=product_id&limit=5000', {}, fetchImpl);
  if (have.status < 200 || have.status >= 300 || !Array.isArray(have.body)) return { error: `อ่านตารางชื่อสินค้าไม่ได้ (HTTP ${have.status})` };
  const known = new Set(have.body.map((r) => String(r.product_id)));
  const unnamed = (Array.isArray(products) ? products : []).filter((p) => p && p.id && !known.has(String(p.id)));
  if (!unnamed.length) return { added: 0, unnamed: 0 };
  const found = namesFromVideos(await client.fetchShopVideos(clientId, month, { maxPages: videoPages }));
  const stamp = new Date().toISOString();
  const rows = Object.entries(found).filter(([id]) => !known.has(id)).map(([id, name]) => ({ product_id: id, name, updated_at: stamp }));
  if (rows.length) {
    await send(cfg, 'POST', '/rest/v1/m039_product_names?on_conflict=product_id', rows, { Prefer: 'resolution=merge-duplicates' }, fetchImpl);
  }
  return { added: rows.length, unnamed: unnamed.filter((p) => !found[String(p.id)]).length };
}

// I/O: per month — pull the shop's per-product sales (all channels) and upsert m039_product_monthly.
// Cheap (a couple of list calls), so the controller runs it before the heavier per-clip sync.
export async function syncProducts({ cfg, client, clientId, months, fetchImpl = fetch, imageBudgetMs = 40_000 }) {
  const results = [];
  // One pool for the whole call, not a fresh allowance per month (a backfill walks many months).
  const imageDeadline = Date.now() + imageBudgetMs;
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

      const out = { month, products: rows.length, gmv: round2(rows.reduce((s, r) => s + r.gmv, 0)), version, ...(truncated ? { truncated: true } : {}), ok: true };
      // Names, then pictures: both come after the sales are safely written and can never fail them.
      if (typeof client.fetchShopVideos === 'function') {
        try { out.names = await syncProductNames({ cfg, client, clientId, month, products, fetchImpl }); }
        catch (e) { out.names = { error: e.message }; }
        if (out.names.error) out.nameWarning = `ชื่อสินค้า: ${out.names.error}`;
      }
      // Pictures come after the sales are safely written and can never fail them. Only runs when the
      // client can fetch them; whatever goes wrong is reported as imageWarning, not as an error.
      if (typeof client.fetchProductImage === 'function') {
        try {
          const left = imageDeadline - Date.now();
          out.images = left > 0
            ? await syncProductImages({ cfg, client, clientId, products, fetchImpl, budgetMs: left })
            : { skipped: 'budget' };
        } catch (e) { out.images = { error: e.message }; }
        if (out.images.error) out.imageWarning = `รูปสินค้า: ${out.images.error}`;
      }
      results.push(out);
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
