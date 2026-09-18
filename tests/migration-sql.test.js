import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mig = readFileSync(new URL('../supabase/migrations/20260911_m039_dashboard.sql', import.meta.url), 'utf8');
const roles = readFileSync(new URL('../supabase/roles_m039_app.sql', import.meta.url), 'utf8');
const M039_TABLES = ['m039_shops', 'm039_ad_accounts', 'm039_shop_monthly', 'm039_ads_monthly', 'm039_ads_items', 'm039_secrets'];

test('migration creates every m039_ table', () => {
  for (const t of M039_TABLES) assert.match(mig, new RegExp(`create table if not exists ${t}\\b`, 'i'));
});

test('every RLS policy is scoped TO m039_app (never a policy without a TO clause)', () => {
  const policies = mig.match(/create policy[\s\S]*?;/gi) || [];
  assert.ok(policies.length >= M039_TABLES.length, 'expected a policy per m039_ table');
  for (const p of policies) assert.match(p, /to\s+m039_app/i, `policy missing TO m039_app: ${p.slice(0, 60)}`);
});

test('roles SQL creates m039_app, grants it to authenticator, and revokes the default ACL from anon/authenticated', () => {
  assert.match(roles, /create role m039_app/i);
  assert.match(roles, /grant m039_app to authenticator/i);
  for (const t of M039_TABLES) {
    assert.match(roles, new RegExp(`revoke all[\\s\\S]*?on[\\s\\S]*?${t}[\\s\\S]*?from[\\s\\S]*?anon`, 'i'), `no REVOKE FROM anon for ${t}`);
  }
  assert.match(roles, /revoke all[\s\S]*?m039_ads_items[\s\S]*?seq[\s\S]*?from[\s\S]*?anon/i);
});

test('roles SQL grants only m039_ tables (no grant on a core table like clients/mcp_tokens)', () => {
  assert.doesNotMatch(roles, /grant[\s\S]*?on\s+(public\.)?(clients|mcp_tokens|shop_connections|agency_settings)\b[\s\S]*?to\s+m039_app/i);
});

test('storage: m039_app may write only the m039-covers bucket', () => {
  assert.match(roles, /grant\s+usage\s+on\s+schema\s+storage\s+to\s+m039_app/i);
  assert.match(roles, /on\s+storage\.objects\s+to\s+m039_app/i);
  assert.match(roles, /bucket_id\s*=\s*'m039-covers'/i);
});
