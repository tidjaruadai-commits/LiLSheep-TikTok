import { Router } from 'express';
import { normalizeKey, looksLikeKey, normalizeInclude } from '../connectors/report-pilot.js';

// Controller holds the current key in memory (restored from the secret store on first use).
// Pure-ish: all I/O is injected, so it unit-tests without Express or a DB.
export function createTikTokController(deps) {
  const { cfg, saveKey, loadKey, makeClient, syncShop, syncAds, syncGmvMax, syncVideos, syncAffiliate, archiveCovers } = deps;
  let key = '';
  let lastSync = null;
  let syncing = false;

  async function ensureKey() { if (!key) key = (await loadKey()) || ''; return key; }
  function client() { return makeClient(() => key); }   // client always reads the controller's live key

  async function connect(raw) {
    const k = normalizeKey(raw);
    if (!looksLikeKey(k)) return { ok: false, error: 'รูปแบบ Token ไม่ถูกต้อง (ต้องขึ้นต้น rpt_)' };
    key = k;
    await saveKey(k);
    return { ok: true };
  }

  async function status() {
    await ensureKey();
    return { connected: !!key, lastSync, base: cfg.reportPilotBase };
  }

  // Steps are isolated: one failing month (a stalled gateway call, a TikTok hiccup) must not stop the
  // ads sync or the cover archive, and whatever a step wrote before failing stays written (every job
  // upserts as it goes). Errors are collected into the result, never swallowed.
  // `include` is opt-in shop enrichment ('lives' | 'products,lives'); default none — see connector.
  // `budgetMs` is the whole run's time budget (Vercel kills a function at 300 s): the cover archive,
  // last and least urgent, only gets what is left and is skipped when nothing is — it catches up
  // on the next run. The data steps themselves are bounded by the connector's per-call timeout.
  async function sync(months, { include = '', budgetMs = 270_000 } = {}) {
    await ensureKey();
    if (!key) return { ok: false, error: 'ยังไม่ได้เชื่อมต่อ Report Pilot' };
    if (syncing) return { ok: false, error: 'กำลังซิงก์อยู่ รอสักครู่' };
    syncing = true;
    const started = Date.now();
    const errors = [];
    const step = async (label, fn) => {
      try { return await fn(); }
      catch (e) { console.error(`sync ${label}:`, e.message); errors.push(`${label}: ${e.message}`); return null; }
    };
    try {
      const c = client();
      const inc = normalizeInclude(include);
      const advertiserIds = (await step('advertisers', () => c.getAdvertiserIds())) || [];
      const shop = [];
      for (const m of months) {
        const r = await step(`shop ${m}`, () => syncShop({ client: c, month: m, include: inc }));
        if (r && r.failed) errors.push(`shop ${m}: Report Pilot returned an error for ${r.failed} shop(s)`);
        shop.push(r);
      }
      const ads = advertiserIds.length ? await step('ads', () => syncAds({ client: c, advertiserIds, months })) : null;
      if (ads && ads.ok === false) (ads.results || []).filter((r) => r.error).forEach((r) => errors.push(`ads ${r.advertiserId} ${r.month}: ${r.error}`));
      // GMV Max: the "sales ad" data the normal ads path never sees (that one only returns
      // awareness campaigns). Same isolation as ads — a failure here never stops the cover archive.
      const gmvmax = advertiserIds.length ? await step('gmvmax', () => syncGmvMax({ client: c, advertiserIds, months })) : null;
      if (gmvmax && gmvmax.ok === false) (gmvmax.results || []).filter((r) => r.error).forEach((r) => errors.push(`gmvmax ${r.advertiserId} ${r.storeId || ''} ${r.month || ''}: ${r.error}`));
      // Per-clip Top Ads: shop-side per-video sales/engagement joined with GMV Max ad ROI. Needs the
      // client_id (shop-side calls are client-scoped). Shop videos exist even with no ad accounts, so
      // this runs whenever we can resolve a client_id. Engagement details are time-budgeted inside the
      // job (they hit TikTok's rate limit) so they never starve the cover archive below.
      let videos = null, affiliate = null;
      if (syncVideos || syncAffiliate) {
        const clientId = await step('clientId', () => c.getClientId());
        if (clientId) {
          if (syncVideos) {
            const leftForVideos = budgetMs - (Date.now() - started);
            // Reserve ~30s for the cover loop and ~30s for the trailing cover archive.
            videos = await step('videos', () => syncVideos({ client: c, clientId, advertiserIds, months, detailBudgetMs: Math.max(0, leftForVideos - 60_000), coverBudgetMs: 30_000 }));
            if (videos && videos.ok === false) (videos.results || []).filter((r) => r.error).forEach((r) => errors.push(`videos ${r.month || ''}: ${r.error}`));
          }
          if (syncAffiliate) {
            affiliate = await step('affiliate', () => syncAffiliate({ client: c, clientId, months }));
            if (affiliate && affiliate.ok === false) (affiliate.results || []).filter((r) => r.error).forEach((r) => errors.push(`affiliate ${r.month || ''}: ${r.error}`));
          }
        }
      }
      const left = budgetMs - (Date.now() - started);
      const covers = left > 0 ? await step('covers', () => archiveCovers({ budgetMs: left })) : { ok: true, skipped: 'budget' };
      if ([...shop, ads, gmvmax, videos, affiliate, covers].some(Boolean)) lastSync = new Date().toISOString();   // partial progress is still a sync
      const ok = errors.length === 0;
      const out = { ok, months, include: inc, advertiserIds, lastSync, shop, ads, gmvmax, videos, affiliate, covers, errors };
      if (!ok) out.error = errors.join(' | ');
      return out;
    } finally { syncing = false; }
  }

  return { connect, status, sync, ensureKey };
}

// Express wiring (owner-only mutations enforced by the caller's requireOwner middleware).
export function createTikTokRouter(controller, { requireOwner }) {
  const router = Router();
  // Express 4 does NOT catch rejections from async handlers — an unhandled one crashes the process.
  // Wrap every handler so a failed DB/gateway call (e.g. Supabase briefly unreachable) becomes a 500,
  // never a server crash.
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error('tiktok route:', e.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
  });
  router.get('/status', wrap(async (req, res) => res.json(await controller.status())));
  router.post('/connect', requireOwner, wrap(async (req, res) => {
    const r = await controller.connect((req.body && req.body.key) || '');
    res.status(r.ok ? 200 : 400).json(r);
  }));
  router.post('/sync', requireOwner, wrap(async (req, res) => {
    const body = req.body || {};
    res.json(await controller.sync(body.months || [], { include: body.include || '' }));
  }));
  return router;
}
