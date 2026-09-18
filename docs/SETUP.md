# Lilsheep-TikTok — one-time setup (Report Pilot Supabase)

> **Status (2026-09-18): the database steps (1a–2) below were already applied to project
> `cjmdmvpbgmqwguakylci` via the Supabase MCP, and structural containment was verified
> (`m039_app` can reach only `m039_*`; zero `SECURITY DEFINER` functions in `public`, so there is no
> definer-RPC path around it; `anon`/`authenticated` were revoked on every `m039_*` table). You only
> need to do **step 3 (mint the JWT)**, **step 4 (run the gate)**, and **step 5 (the Lilsheep `rpt_`
> token — already connected in Report Pilot; just mint a scoped token for this app)**. The SQL steps
> are kept here for the record and for a fresh environment.

Run in order, ONCE, against Report Pilot's Supabase project `cjmdmvpbgmqwguakylci`.

**Ordering matters:** the migration's `create policy … to m039_app` needs the role to exist first, so
create the role BEFORE the migration.

1a. **Create the role first** — run just the role-creation block:
   ```sql
   do $$ begin if not exists (select 1 from pg_roles where rolname='m039_app') then create role m039_app nologin; end if; end $$;
   grant m039_app to authenticator;
   ```
1b. **Apply the migration** — run `supabase/migrations/20260911_m039_dashboard.sql` (tables + RLS
   policies). Additive only.
2. **Grants + revokes + bucket** — run the rest of `supabase/roles_m039_app.sql` (everything after the
   `grant m039_app to authenticator;` line).
3. **Mint the app JWT** — locally. Copy the printed token → this is `SUPABASE_M039_JWT`.
   - PowerShell (Windows): `$env:SUPABASE_JWT_SECRET='<legacy Supabase JWT secret>'; npm run mint-jwt`
   - bash: `SUPABASE_JWT_SECRET='<legacy Supabase JWT secret>' npm run mint-jwt`
   Do NOT rotate the legacy JWT secret afterward (it still signs Report Pilot's own key). To revoke
   THIS token if leaked: `REVOKE m039_app FROM authenticator;` (does not touch the secret).
4. **Run the containment gate** — set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_M039_JWT`, then:
   - PowerShell: `$env:SUPABASE_URL='…'; $env:SUPABASE_ANON_KEY='…'; $env:SUPABASE_M039_JWT='…'; npm run containment-check`
   - bash: `SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_M039_JWT=… npm run containment-check`
   It MUST print `CONTAINMENT OK`. If any line says FAIL, stop — the role is not contained; do not
   connect real data until it passes.
5. Mint a Lilsheep-scoped `rpt_` token in Report Pilot → Settings → API Tokens, then paste it into this
   app's Setup tab after first deploy (or set `REPORT_PILOT_KEY` as an env var instead).
