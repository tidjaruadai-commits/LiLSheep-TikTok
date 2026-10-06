-- Product names for the Products tab. ADDITIVE ONLY. Applied to Report Pilot's Supabase project
-- (cjmdmvpbgmqwguakylci). Self-contained: table + RLS + grants + the CRITICAL anon revoke.
-- The per-product sales list (shop_products/performance) carries ids and numbers but no name, so names
-- are collected from the shop video list, whose rows list their products as { id, name }. One row per
-- product (a name does not change month to month), kept across months so a product named once stays
-- named in every month it sells.

create table if not exists m039_product_names (
  product_id text primary key,
  name text not null,
  updated_at timestamptz not null default now()
);

alter table m039_product_names enable row level security;
drop policy if exists m039_product_names_m039_app on m039_product_names;
create policy m039_product_names_m039_app on m039_product_names for all to m039_app using (true) with check (true);

grant select, insert, update, delete on m039_product_names to m039_app;
revoke all on table m039_product_names from anon, authenticated, public;
