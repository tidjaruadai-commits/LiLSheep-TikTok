import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLogin, RateLimiter } from '../lib/auth.js';

test('checkLogin matches owner user + password from config', () => {
  const cfg = { ownerUser: 'owner', ownerPassword: 'secret' };
  assert.equal(checkLogin('owner', 'secret', cfg), true);
  assert.equal(checkLogin('owner', 'wrong', cfg), false);
  assert.equal(checkLogin('nope', 'secret', cfg), false);
});

test('checkLogin refuses when no password is configured (fail-closed)', () => {
  assert.equal(checkLogin('owner', '', { ownerUser: 'owner', ownerPassword: '' }), false);
});

test('RateLimiter blocks after N failures per key and resets on success', () => {
  const rl = new RateLimiter({ max: 3, windowMs: 10000 });
  assert.equal(rl.blocked('1.2.3.4'), false);
  rl.fail('1.2.3.4'); rl.fail('1.2.3.4'); rl.fail('1.2.3.4');
  assert.equal(rl.blocked('1.2.3.4'), true);
  rl.reset('1.2.3.4');
  assert.equal(rl.blocked('1.2.3.4'), false);
});
