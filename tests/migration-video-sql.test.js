import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20260914_m039_video_monthly.sql', import.meta.url), 'utf8');

test('creates m039_video_monthly keyed by (month, video_id)', () => {
  assert.match(sql, /create table if not exists m039_video_monthly\b/i);
  assert.match(sql, /primary key\s*\(\s*month\s*,\s*video_id\s*\)/i);
});

test('ad-attributed + engagement columns are nullable (null distinguishes "not measured" from 0)', () => {
  for (const col of ['ad_cost', 'ad_gross_revenue', 'ad_orders', 'ad_roi', 'likes', 'comments', 'shares', 'new_followers']) {
    assert.match(sql, new RegExp(`\\b${col}\\s+(numeric|bigint|int)\\b(?!\\s+not null)`, 'i'), `${col} must be nullable`);
  }
});

test('RLS enabled with exactly one policy scoped TO m039_app (never a bare PUBLIC policy)', () => {
  assert.match(sql, /alter table m039_video_monthly\s+enable row level security/i);
  const policies = sql.match(/create policy[\s\S]*?;/gi) || [];
  assert.equal(policies.length, 1);
  assert.match(policies[0], /to\s+m039_app/i);
});

test('grants m039_app and REVOKES the Supabase default ACL from anon/authenticated/public', () => {
  assert.match(sql, /grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+m039_video_monthly\s+to\s+m039_app/i);
  assert.match(sql, /revoke all on table m039_video_monthly from anon, authenticated, public/i);
});
