-- Per-clip Top Ads: one row per TikTok video/clip per month. Shop-side sales/reach (organic +
-- affiliate + ads) joined with GMV Max ad-attributed cost/ROI (item_id == shop video id). ADDITIVE
-- ONLY. Applied to Report Pilot's Supabase project (cjmdmvpbgmqwguakylci). Self-contained: table +
-- RLS + grants + the CRITICAL anon revoke (Supabase auto-grants every new public table to anon).

create table if not exists m039_video_monthly (
  month text not null,
  video_id text not null,
  title text not null default '',
  username text not null default '',          -- creator/affiliate handle (channel)
  product text not null default '',
  post_time text not null default '',
  -- shop-side per-clip sales & reach (always present)
  gmv numeric not null default 0,
  orders int not null default 0,
  items_sold int not null default 0,
  views bigint not null default 0,
  ctr numeric not null default 0,
  gpm numeric not null default 0,
  -- GMV Max ad-attributed (null = this clip had no GMV Max ad spend)
  ad_cost numeric,
  ad_gross_revenue numeric,
  ad_orders int,
  ad_roi numeric,
  -- engagement from the rate-limited detail endpoint (null = not measured for this clip this run)
  likes bigint,
  comments bigint,
  shares bigint,
  new_followers bigint,
  synced_at timestamptz not null default now(),
  primary key (month, video_id)
);

-- RLS: enabled, EXACTLY one policy, explicitly scoped TO m039_app (a bare policy defaults to PUBLIC).
alter table m039_video_monthly enable row level security;
drop policy if exists m039_video_monthly_m039_app on m039_video_monthly;
create policy m039_video_monthly_m039_app on m039_video_monthly for all to m039_app using (true) with check (true);

-- Least-privilege grant + the mandatory revoke of Supabase's default anon/authenticated ACL.
grant select, insert, update, delete on m039_video_monthly to m039_app;
revoke all on table m039_video_monthly from anon, authenticated, public;
