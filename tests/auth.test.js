import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLogin, RateLimiter } from '../lib/auth.js';

test('checkLogin matches owner user + password from config', () => {
  const cfg = { ownerUser: 'owner', ownerPassword: 'secret' };
  assert.equal(checkLogin('owner', 'secret', cfg), 'owner');
  assert.equal(checkLogin('owner', 'wrong', cfg), '');
  assert.equal(checkLogin('nope', 'secret', cfg), '');
});

test('checkLogin refuses when no password is configured (fail-closed)', () => {
  assert.equal(checkLogin('owner', '', { ownerUser: 'owner', ownerPassword: '' }), '');
});

test('checkLogin gives a VIEWERS account the read-only role, never owner', () => {
  const cfg = { ownerUser: 'owner', ownerPassword: 'secret', viewers: [{ user: 'malee', pass: 'hunter2' }] };
  assert.equal(checkLogin('malee', 'hunter2', cfg), 'viewer');
  assert.equal(checkLogin('malee', 'secret', cfg), '', 'a viewer cannot log in with the owner password');
  assert.equal(checkLogin('owner', 'hunter2', cfg), '', "and the owner name does not accept a viewer's password");
});

test('checkLogin never lets a blank or half-written viewer entry become an open door', () => {
  const cfg = { ownerUser: 'owner', ownerPassword: 'secret', viewers: [{ user: 'ghost', pass: '' }, null] };
  assert.equal(checkLogin('ghost', '', cfg), '');
  assert.equal(checkLogin('', '', cfg), '');
});

test('RateLimiter blocks after N failures per key and resets on success', () => {
  const rl = new RateLimiter({ max: 3, windowMs: 10000 });
  assert.equal(rl.blocked('1.2.3.4'), false);
  rl.fail('1.2.3.4'); rl.fail('1.2.3.4'); rl.fail('1.2.3.4');
  assert.equal(rl.blocked('1.2.3.4'), true);
  rl.reset('1.2.3.4');
  assert.equal(rl.blocked('1.2.3.4'), false);
});
