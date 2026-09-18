-- Lilsheep-TikTok dashboard tables. ADDITIVE ONLY — never alter/drop a Report Pilot table.
-- Applied to Report Pilot's Supabase project (cjmdmvpbgmqwguakylci).

create table if not exists m039_shops (
  key text primary key,
  name text not null,
  tiktok_handle text,
  shop_code text,
  sort int not null default 0
);

create table if not exists m039_ad_accounts (
  advertiser_id text primary key,
  name text not null,
  shop_key text references m039_shops(key) on delete set null,
  sort int not null default 0
);

create table if not exists m039_shop_monthly (
  month text not null,
  shop_key text not null references m039_shops(key) on delete cascade,
  gmv numeric not null default 0,
  refund numeric not null default 0,
  orders int not null default 0,
  units int not null default 0,
  gmv_live numeric not null default 0,
  gmv_video numeric not null default 0,
  gmv_product_card numeric not null default 0,
  visitors bigint not null default 0,
  page_views bigint not null default 0,
  gross_revenue numeric not null default 0,
  top_products jsonb,
  live_sessions jsonb,
  synced_at timestamptz,
  primary key (month, shop_key)
);

create table if not exists m039_ads_monthly (
  month text not null,
  advertiser_id text not null references m039_ad_accounts(advertiser_id) on delete cascade,
  campaign_type text not null,
  spend numeric not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  results bigint not null default 0,
  result_label text,
  engagement bigint not null default 0,
  video_views bigint not null default 0,
  gmv_ads numeric not null default 0,
  primary key (month, advertiser_id, campaign_type)
);

create table if not exists m039_ads_items (
  id bigint generated always as identity primary key,
  month text not null,
  advertiser_id text not null references m039_ad_accounts(advertiser_id) on delete cascade,
  ad_id text,
  ad_name text not null,
  caption text,
  campaign_type text,
  cover_url text,
  video_url text,
  spend numeric not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  results bigint not null default 0,
  result_label text,
  engagement bigint not null default 0,
  video_views bigint not null default 0,
  deep_score numeric not null default 0,
  gmv numeric not null default 0,
  unique (month, advertiser_id, ad_id)
);

create table if not exists m039_secrets (
  id text primary key,
  ciphertext text not null,
  updated_at timestamptz not null default now()
);

-- RLS: enable on every table; EXACTLY one policy each, written explicitly and scoped TO m039_app
-- (never a bare policy — a policy with no TO clause defaults to PUBLIC and would re-expose rows).
alter table m039_shops        enable row level security;
alter table m039_ad_accounts  enable row level security;
alter table m039_shop_monthly enable row level security;
alter table m039_ads_monthly  enable row level security;
alter table m039_ads_items    enable row level security;
alter table m039_secrets      enable row level security;

drop policy if exists m039_shops_m039_app        on m039_shops;
drop policy if exists m039_ad_accounts_m039_app  on m039_ad_accounts;
drop policy if exists m039_shop_monthly_m039_app on m039_shop_monthly;
drop policy if exists m039_ads_monthly_m039_app  on m039_ads_monthly;
drop policy if exists m039_ads_items_m039_app    on m039_ads_items;
drop policy if exists m039_secrets_m039_app      on m039_secrets;

create policy m039_shops_m039_app        on m039_shops        for all to m039_app using (true) with check (true);
create policy m039_ad_accounts_m039_app  on m039_ad_accounts  for all to m039_app using (true) with check (true);
create policy m039_shop_monthly_m039_app on m039_shop_monthly for all to m039_app using (true) with check (true);
create policy m039_ads_monthly_m039_app  on m039_ads_monthly  for all to m039_app using (true) with check (true);
create policy m039_ads_items_m039_app    on m039_ads_items    for all to m039_app using (true) with check (true);
create policy m039_secrets_m039_app      on m039_secrets      for all to m039_app using (true) with check (true);
