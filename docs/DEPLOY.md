# Lilsheep-TikTok — deploy

Prerequisite: **finish `docs/SETUP.md` first** (migration + m039_app role + JWT + `npm run containment-check` = CONTAINMENT OK). Do not deploy against live data until that passes.

## Option 1 — Vercel (free)

The app ships a serverless entry (`api/index.js`) + `vercel.json`. On Vercel it runs per-request (no
always-on process), so instead of the 6-hour background timer, a **Vercel Cron** hits `/api/cron/sync`
once a day (`vercel.json`). The "ซิงก์ตอนนี้" button still triggers a sync on demand.

1. Vercel → **Add New → Project → Import** this GitHub repo. Framework preset: **Other** (no build).
2. **Environment Variables** — add:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_M039_JWT`, `SECRET_STORE_KEY`, `OWNER_USER`, `OWNER_PASSWORD`
   - `CRON_SECRET` — any long random string (Vercel Cron sends it as `Authorization: Bearer …`).
   - Do NOT set `NODE_ENV` (Vercel sets it to `production` itself; `VERCEL` is also set automatically).
3. **Deploy.** Open the URL → log in as the owner → Setup tab → paste the Lilsheep-scoped `rpt_` token →
   "ซิงก์ตอนนี้". Vercel Cron then refreshes daily.
4. Sanity: the manual sync fills the dashboard tabs for the selected month; cron runs show in Vercel logs.

Note: Vercel Hobby crons run about once a day — fine for a monthly dashboard. Need more frequent
auto-sync? Use Option 2.

**Function budget (why the sync is "light"):** a Vercel function is killed at 300 s (Hobby max; do
NOT set a smaller `maxDuration`). Report Pilot's `/shop-metrics?include=products` pages through every
order of the month to recover product names — 5+ minutes for this shop — so the sync sends **no
`include` by default** (core GMV/orders/channel split + ads land in seconds). Enrichment is opt-in:
`GET /api/cron/sync?include=lives` (fast, one call) or POST `/api/tiktok/sync` with
`{ "months": ["2026-09"], "include": "lives" }`. Each gateway call is also capped at 120 s, and every
step is isolated, so one slow month never blocks the ads sync — the cron response lists per-step
results and `errors`. The whole run works to a 270 s budget: the cover archive (last step, ~1.7 s per
new clip) only uses what is left and reports `remaining`; the next run finishes the rest. Measured
2026-09-12: shop ≈ 1 s/month, ads ≈ 50–85 s/month, first-ever cover backlog 87 clips ≈ 150 s.

## Option 2 — Railway / any always-on host (paid)

1. New Project → Deploy from GitHub → this repo, branch `master`.
2. **Variables** from `.env.example` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_M039_JWT`,
   `SECRET_STORE_KEY`, `OWNER_USER`, `OWNER_PASSWORD`; `NODE_ENV=production`). Do NOT set `VERCEL`.
3. Runs `npm start` (server.js), listens on `$PORT`, and the built-in 6h auto-sync + 12h cover archive
   run in-process — no cron needed.
4. Open the URL → log in → Setup tab → paste the `rpt_` token → sync.
