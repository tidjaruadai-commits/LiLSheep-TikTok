import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildM039Claims } from '../scripts/mint-m039-jwt.js';

test('claims carry role m039_app and an exp within ~1 year', () => {
  const now = 1_700_000_000;
  const c = buildM039Claims({ now, days: 365 });
  assert.equal(c.role, 'm039_app');
  assert.equal(c.iss, 'm039-lilsheep-tiktok');
  assert.equal(c.exp, now + 365 * 86400);
  assert.ok(c.exp > now);
});

test('exp is capped at 1 year even if a larger window is requested', () => {
  const now = 1_700_000_000;
  assert.equal(buildM039Claims({ now, days: 5000 }).exp, now + 365 * 86400);
});
