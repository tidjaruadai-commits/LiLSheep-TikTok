-- Affiliate/creator analysis tab. ADDITIVE ONLY. Applied to Report Pilot's Supabase project
-- (cjmdmvpbgmqwguakylci). Self-contained: tables + RLS + grants + the CRITICAL anon revoke.
-- m039_affiliate_monthly: one row per month (growth series + how many affiliate videos/lives carried a
-- Lilsheep product — the honest proxy for "creators who attached the product" until the TikTok Affiliate
-- Seller scope is granted). m039_affiliate_creators: per-creator VDO/Live rankings for the month.

create table if not exists m039_affiliate_monthly (
  month text not null,
  gmv_video numeric not null default 0,
  gmv_live numeric not null default 0,
  orders_video int not null default 0,
  orders_live int not null default 0,
  video_count bigint not null default 0,        -- affiliate videos carrying a product this month
  live_count bigint not null default 0,         -- affiliate live sessions carrying a product this month
  synced_at timestamptz not null default now(),
  primary key (month)
);

create table if not exists m039_affiliate_creators (
  month text not null,
  username text not null,
  videos int not null default 0,
  gmv_video numeric not null default 0,
  orders_video int not null default 0,
  views_video bigint not null default 0,
  lives int not null default 0,
  gmv_live numeric not null default 0,
  orders_live int not null default 0,
  synced_at timestamptz not null default now(),
  primary key (month, username)
);

alter table m039_affiliate_monthly  enable row level security;
alter table m039_affiliate_creators enable row level security;

drop policy if exists m039_affiliate_monthly_m039_app  on m039_affiliate_monthly;
drop policy if exists m039_affiliate_creators_m039_app on m039_affiliate_creators;
create policy m039_affiliate_monthly_m039_app  on m039_affiliate_monthly  for all to m039_app using (true) with check (true);
create policy m039_affiliate_creators_m039_app on m039_affiliate_creators for all to m039_app using (true) with check (true);

grant select, insert, update, delete on m039_affiliate_monthly  to m039_app;
grant select, insert, update, delete on m039_affiliate_creators to m039_app;
revoke all on table m039_affiliate_monthly from anon, authenticated, public;
revoke all on table m039_affiliate_creators from anon, authenticated, public;
