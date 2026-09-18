import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { requireEnv, getConfig } from './lib/env.js';
import { checkLogin, RateLimiter } from './lib/auth.js';
import { createReportPilotClient } from './connectors/report-pilot.js';
import { saveSecret, loadSecret } from './lib/secret-store.js';
import { syncShopMetrics } from './lib/shop-sync.js';
import { syncAds } from './lib/ads-sync.js';
import { syncGmvMax } from './lib/gmvmax-sync.js';
import { syncVideos } from './lib/video-sync.js';
import { syncAffiliate } from './lib/affiliate-sync.js';
import { archiveCovers } from './lib/cover-archive.js';
import { createTikTokController, createTikTokRouter } from './routes/tiktok.js';
import { createDashboardRouter } from './routes/dashboard.js';

requireEnv();                       // refuse to boot without the mandatory secrets
const cfg = getConfig();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const loginLimiter = new RateLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
const SECRET_ID = 'tiktok';
const sessionKey = crypto.scryptSync(cfg.secretStoreKey, 'm039-session-key-v1', 32).toString('base64');

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({ name: 'm039tt', keys: [sessionKey], maxAge: 12 * 3600 * 1000, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }));

function requireAuth(req, res, next) {
  if (req.session && req.session.role) return next();
  // /api/cron/sync is not a logged-in call; it protects itself with CRON_SECRET (see below).
  if (req.path === '/login' || req.path === '/healthz' || req.path === '/api/cron/sync') return next();
  if (req.path.toLowerCase().startsWith('/api/')) return res.status(401).json({ ok: false, error: 'ต้องเข้าสู่ระบบ' });
  return res.redirect('/login');
}
function requireOwner(req, res, next) {
  if (!req.session || req.session.role !== 'owner') return res.status(403).json({ ok: false, error: 'สำหรับเจ้าของเท่านั้น' });
  next();
}

const WEBROOT = path.join(__dirname, 'webroot');   // NOT "public" — Vercel auto-serves a public/ dir
app.get('/healthz', (req, res) => res.json({ ok: true }));
// Explicit root handler (before requireAuth) so the home path is deterministic on serverless and never
// collides with a Vercel-static directory: logged-in -> the dashboard, otherwise -> login.
const serveRoot = (req, res) => (req.session && req.session.role)
  ? res.sendFile(path.join(WEBROOT, 'index.html'))
  : res.redirect(303, '/login');
app.get('/', serveRoot);
app.post('/', serveRoot);   // belt-and-suspenders: if Vercel still 307s a post-login redirect to /, handle it
app.get('/login', (req, res) => (req.session && req.session.role) ? res.redirect('/') : res.sendFile(path.join(WEBROOT, 'login.html')));
// NOTE: redirect with 303 (See Other) after a POST. Vercel rewrites a plain 302 from a serverless
// function into a 307 (method-preserving), which would re-POST to the target (e.g. "Cannot POST /"
// after login, and an infinite loop on a failed login). 303 forces the browser to follow with GET.
app.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginLimiter.blocked(ip)) return res.redirect(303, '/login?error=locked');
  const { username, password } = req.body || {};
  if (checkLogin(username, password, cfg)) { loginLimiter.reset(ip); req.session.role = 'owner'; req.session.user = username; return res.redirect(303, '/'); }
  loginLimiter.fail(ip);
  res.redirect(303, '/login?error=1');
});
app.post('/logout', (req, res) => { req.session = null; res.redirect(303, '/login'); });

app.use(requireAuth);
// env.js deliberately exposes NO Supabase credentials to the browser.
app.get('/env.js', (req, res) => { res.type('application/javascript'); res.send(`window.__ENV=${JSON.stringify({ role: req.session.role || '' })};`); });

// The controller owns the key and builds one client per sync (via makeClient); each job receives
// that client, so there is no separate key to thread through the server.
const controller = createTikTokController({
  cfg,
  saveKey: (k) => saveSecret(cfg, SECRET_ID, k),
  loadKey: () => loadSecret(cfg, SECRET_ID),
  makeClient: (getKey) => createReportPilotClient({ base: cfg.reportPilotBase, getKey }),
  syncShop: ({ client, month }) => syncShopMetrics({ cfg, client, month }),
  syncAds: ({ client, advertiserIds, months }) => syncAds({ cfg, client, advertiserIds, months }),
  syncGmvMax: ({ client, advertiserIds, months }) => syncGmvMax({ cfg, client, advertiserIds, months }),
  syncVideos: ({ client, clientId, advertiserIds, months, detailBudgetMs, coverBudgetMs }) => syncVideos({ cfg, client, clientId, advertiserIds, months, detailBudgetMs, coverBudgetMs }),
  syncAffiliate: ({ client, clientId, months }) => syncAffiliate({ cfg, client, clientId, months }),
  archiveCovers: (opts) => archiveCovers({ cfg, ...(opts || {}) }),   // controller passes its remaining budgetMs
});
controller.ensureKey().catch(() => {});   // warm the key from the store on boot (best-effort)

app.use('/api/tiktok', createTikTokRouter(controller, { requireOwner }));
app.use('/api', createDashboardRouter(cfg));
app.use(express.static(WEBROOT));

function currentAndPrevMonth() {
  const d = new Date(); const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const fmt = (yy, mm) => `${yy}-${String(mm + 1).padStart(2, '0')}`;
  const prev = m === 0 ? [y - 1, 11] : [y, m - 1];
  return [fmt(y, m), fmt(prev[0], prev[1])];
}
// One scheduled pass: current + previous month (controller.sync already archives covers at the end).
// Returns the controller's summary — per-step results + collected errors — so a cron response or
// log line shows what actually happened instead of a blind { ok: true }.
async function autoSync(include = '') {
  try { return await controller.sync(currentAndPrevMonth(), { include }); }
  catch (e) { console.error('autoSync:', e.message); return { ok: false, error: e.message }; }
}

// Scheduled sync for serverless (Vercel Cron) — there is no always-on process to run setInterval.
// Protected by CRON_SECRET: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Exempted from
// requireAuth above. On a persistent host the 6h timers below do the same job.
// Optional `?include=lives` (or `products,lives`) adds shop enrichment. Off by default on purpose:
// `products` makes Report Pilot page every order of the month (5+ min on this shop) and Vercel kills
// the function at 300s — the core sync must always land first.
app.get('/api/cron/sync', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (!secret || (req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json(await autoSync(String(req.query.include || '')));
});

// Persistent-host mode only. On Vercel (serverless) VERCEL is set, so we never bind a port or start
// timers — the /api/cron/sync route above is driven by Vercel Cron instead.
if (!process.env.M039_NO_LISTEN && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Lilsheep-TikTok on :${PORT}`);
    setTimeout(() => autoSync(), 15000);
    setInterval(() => autoSync(), 6 * 3600 * 1000);
    setTimeout(() => archiveCovers({ cfg }).catch(() => {}), 40000);
    setInterval(() => archiveCovers({ cfg }).catch(() => {}), 12 * 3600 * 1000);
  });
}

// Vercel auto-detects this Express app (package.json "main") and invokes server.js as a serverless
// function, which requires a DEFAULT export that is a request handler. The Express app IS one.
export { app };
export default app;
