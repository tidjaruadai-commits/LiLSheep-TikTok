import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20261006_m039_product_monthly.sql', import.meta.url), 'utf8');

test('creates m039_product_monthly keyed by (month, product_id)', () => {
  assert.match(sql, /create table if not exists m039_product_monthly\b/i);
  assert.match(sql, /primary key\s*\(\s*month\s*,\s*product_id\s*\)/i);
});

test('RLS enabled with exactly one policy scoped TO m039_app (never a bare PUBLIC policy)', () => {
  assert.match(sql, /alter table m039_product_monthly\s+enable row level security/i);
  const policies = sql.match(/create policy[\s\S]*?;/gi) || [];
  assert.equal(policies.length, 1);
  assert.match(policies[0], /to\s+m039_app/i);
});

test('grants m039_app and REVOKES the Supabase default ACL from anon/authenticated/public', () => {
  assert.match(sql, /grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+m039_product_monthly\s+to\s+m039_app/i);
  assert.match(sql, /revoke all on table m039_product_monthly from anon, authenticated, public/i);
});

const imgSql = readFileSync(new URL('../supabase/migrations/20261006_m039_product_images.sql', import.meta.url), 'utf8');

test('m039_product_images is one row per product (not per month) and stores OUR url', () => {
  assert.match(imgSql, /create table if not exists m039_product_images\b/i);
  assert.match(imgSql, /product_id text primary key/i);
  assert.match(imgSql, /image_url text not null/i);
});

test('m039_product_images: RLS with exactly one policy TO m039_app, grants, and the anon revoke', () => {
  assert.match(imgSql, /alter table m039_product_images\s+enable row level security/i);
  const policies = imgSql.match(/create policy[\s\S]*?;/gi) || [];
  assert.equal(policies.length, 1);
  assert.match(policies[0], /to\s+m039_app/i);
  assert.match(imgSql, /grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+m039_product_images\s+to\s+m039_app/i);
  assert.match(imgSql, /revoke all on table m039_product_images from anon, authenticated, public/i);
});
