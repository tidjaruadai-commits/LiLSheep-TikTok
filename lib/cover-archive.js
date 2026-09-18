import { dbFetch, buildHeaders } from './db.js';

// TikTok CDN cover URLs expire (~2 days). Copy fresh ones into the public m039-covers bucket and
// rewrite cover_url to our stable public URL. Uses the m039_app client for both DB and Storage.
// `budgetMs` (0 = unlimited): stop starting new rows once the budget is spent and report `remaining`
// — each cover is ~1.7 s, a fresh month can carry 80+, and a serverless run must return before it
// is killed. Rows already rewritten are never re-fetched, so the next run simply continues.
export async function archiveCovers({ cfg, fetchImpl = fetch, budgetMs = 0 } = {}) {
  const started = Date.now();
  const bucket = cfg.coversBucket || 'm039-covers';
  const { status, body } = await dbFetch(cfg,
    '/rest/v1/m039_ads_items?select=id,ad_id,cover_url&cover_url=like.*tiktokcdn*', {}, fetchImpl);
  if (status < 200 || status >= 300 || !Array.isArray(body)) return { ok: false, error: `read failed (HTTP ${status})` };

  let archived = 0, expired = 0, failed = 0, processed = 0, stopped;
  for (const row of body) {
    if (budgetMs > 0 && Date.now() - started >= budgetMs) { stopped = 'budget'; break; }
    processed++;
    try {
      const img = await fetchImpl(row.cover_url);
      if (!img.status || img.status < 200 || img.status >= 300) { expired++; continue; }
      const type = (img.headers && img.headers.get && img.headers.get('content-type')) || 'image/jpeg';
      const buf = Buffer.from(await img.arrayBuffer());
      const name = `${row.ad_id || row.id}.jpg`;
      const up = await fetchImpl(`${cfg.supabaseUrl}/storage/v1/object/${bucket}/${name}`, {
        method: 'POST', headers: { ...buildHeaders(cfg), 'Content-Type': type, 'x-upsert': 'true' }, body: buf,
      });
      if (up.status < 200 || up.status >= 300) { failed++; continue; }
      const publicUrl = `${cfg.supabaseUrl}/storage/v1/object/public/${bucket}/${name}`;
      const patch = await dbFetch(cfg, `/rest/v1/m039_ads_items?id=eq.${row.id}`,
        { method: 'PATCH', body: JSON.stringify({ cover_url: publicUrl }) }, fetchImpl);
      if (patch.status >= 200 && patch.status < 300) archived++; else failed++;
    } catch { failed++; }
  }
  const result = { ok: true, total: body.length, archived, expired, failed, remaining: body.length - processed };
  if (stopped) result.stopped = stopped;
  if (body.length) console.log('cover-archive:', JSON.stringify(result));
  return result;
}
