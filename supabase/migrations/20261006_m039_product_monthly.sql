-- Per-product sales straight from TikTok Shop Analytics (Seller Center -> Analytics -> Products), all
-- channels (LIVE + video + product card). ADDITIVE ONLY. Applied to Report Pilot's Supabase project
-- (cjmdmvpbgmqwguakylci). Self-contained: table + RLS + grants + the CRITICAL anon revoke.
-- Replaces summing m039_video_monthly by clip, which only ever saw the video channel (about a quarter
-- of the shop's GMV) and counted only each clip's first product.

create table if not exists m039_product_monthly (
  month text not null,
  product_id text not null,
  name text not null default '',
  gmv numeric not null default 0,
  orders int not null default 0,
  items_sold int not null default 0,
  synced_at timestamptz not null default now(),
  primary key (month, product_id)
);

alter table m039_product_monthly enable row level security;
drop policy if exists m039_product_monthly_m039_app on m039_product_monthly;
create policy m039_product_monthly_m039_app on m039_product_monthly for all to m039_app using (true) with check (true);

grant select, insert, update, delete on m039_product_monthly to m039_app;
revoke all on table m039_product_monthly from anon, authenticated, public;
