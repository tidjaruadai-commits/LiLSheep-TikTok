-- Least-privilege role for Lilsheep-TikTok. Run AFTER the migration (tables must exist).
-- m039_app reaches ONLY m039_* tables + the m039-covers bucket. Nothing else.

-- Idempotent role creation (re-running this file must not error).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'm039_app') then
    create role m039_app nologin;
  end if;
end $$;
grant m039_app to authenticator;                 -- lets PostgREST switch into it from the JWT role claim

-- Schema usage is required before any table in it is reachable. storage granted below; public here.
grant usage on schema public to m039_app;

-- Table privileges on m039_* ONLY.
grant select, insert, update, delete on
  m039_shops, m039_ad_accounts, m039_shop_monthly, m039_ads_monthly, m039_ads_items, m039_secrets
  to m039_app;
grant usage, select on sequence m039_ads_items_id_seq to m039_app;

-- CRITICAL: Supabase's default ACL grants every NEW public table to anon/authenticated.
-- Revoke it (and PUBLIC as belt-and-suspenders), or the public anon key could read m039_secrets.
revoke all on table m039_shops        from anon, authenticated, public;
revoke all on table m039_ad_accounts  from anon, authenticated, public;
revoke all on table m039_shop_monthly from anon, authenticated, public;
revoke all on table m039_ads_monthly  from anon, authenticated, public;
revoke all on table m039_ads_items    from anon, authenticated, public;
revoke all on table m039_secrets      from anon, authenticated, public;
revoke all on sequence m039_ads_items_id_seq from anon, authenticated, public;

-- Functions: m039_app is a member of PUBLIC, which holds EXECUTE on public functions by default.
-- This is only a containment risk for SECURITY DEFINER functions. Verified 2026-09-11 (live query on
-- project cjmdmvpbgmqwguakylci): there are ZERO security-definer functions in schema public, so there
-- is no definer-RPC path from m039_app to core data. Do NOT blanket `revoke execute ... from public`
-- (that would break Report Pilot's own anon/authenticated callers). Re-verify if that ever changes;
-- the containment gate (scripts/containment-check.js) also probes the known PUBLIC-EXECUTE rpc.

-- Storage: m039_app may read/write ONLY the m039-covers bucket.
insert into storage.buckets (id, name, public)
  values ('m039-covers', 'm039-covers', true)
  on conflict (id) do nothing;

grant usage on schema storage to m039_app;
grant select, insert, update, delete on storage.objects to m039_app;   -- delete matches the `for all` policy
grant select on storage.buckets to m039_app;   -- storage-api resolves the target bucket under the caller's role on upload

drop policy if exists m039_covers_rw on storage.objects;
create policy m039_covers_rw on storage.objects
  for all to m039_app
  using (bucket_id = 'm039-covers')
  with check (bucket_id = 'm039-covers');
