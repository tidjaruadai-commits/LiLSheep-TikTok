-- Product thumbnails for the Products tab. ADDITIVE ONLY. Applied to Report Pilot's Supabase project
-- (cjmdmvpbgmqwguakylci). Self-contained: table + RLS + grants + the CRITICAL anon revoke.
-- One row per product (not per month — a product's picture does not change month to month).
-- image_url is OUR copy in the public m039-covers bucket, never the TikTok CDN URL: those are signed
-- and expire within days, so storing them would leave broken images a few days after every sync.

create table if not exists m039_product_images (
  product_id text primary key,
  image_url text not null,
  updated_at timestamptz not null default now()
);

alter table m039_product_images enable row level security;
drop policy if exists m039_product_images_m039_app on m039_product_images;
create policy m039_product_images_m039_app on m039_product_images for all to m039_app using (true) with check (true);

grant select, insert, update, delete on m039_product_images to m039_app;
revoke all on table m039_product_images from anon, authenticated, public;
