import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20260914_m039_affiliate.sql', import.meta.url), 'utf8');
const TABLES = ['m039_affiliate_monthly', 'm039_affiliate_creators'];

test('creates both affiliate tables', () => {
  for (const t of TABLES) assert.match(sql, new RegExp(`create table if not exists ${t}\\b`, 'i'));
  assert.match(sql, /m039_affiliate_monthly[\s\S]*?primary key\s*\(\s*month\s*\)/i);
  assert.match(sql, /m039_affiliate_creators[\s\S]*?primary key\s*\(\s*month\s*,\s*username\s*\)/i);
});

test('RLS enabled with exactly one policy per table, all scoped TO m039_app', () => {
  for (const t of TABLES) assert.match(sql, new RegExp(`alter table ${t}\\s+enable row level security`, 'i'));
  const policies = sql.match(/create policy[\s\S]*?;/gi) || [];
  assert.equal(policies.length, TABLES.length);
  for (const p of policies) assert.match(p, /to\s+m039_app/i);
});

test('grants m039_app and REVOKES the Supabase default ACL from anon/authenticated/public for both tables', () => {
  for (const t of TABLES) {
    assert.match(sql, new RegExp(`grant\\s+select,\\s*insert,\\s*update,\\s*delete\\s+on\\s+${t}\\s+to\\s+m039_app`, 'i'));
    assert.match(sql, new RegExp(`revoke all on table ${t} from anon, authenticated, public`, 'i'));
  }
});
