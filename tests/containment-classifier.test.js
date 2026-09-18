import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDenied, isAllowed, isDeniedStorage } from '../scripts/containment-check.js';

test('403 with code 42501 is DENIED (contained)', () => {
  assert.equal(isDenied({ status: 403, body: { code: '42501', message: 'permission denied for table clients' } }), true);
});

test('200 [] is NOT denied — an RLS-empty table looks the same as no rows (must FAIL the negative check)', () => {
  assert.equal(isDenied({ status: 200, body: [] }), false);
});

test('200 with rows is ALLOWED', () => {
  assert.equal(isAllowed({ status: 200, body: [{ key: 'shop1' }] }), true);
  assert.equal(isAllowed({ status: 201, body: null }), true);
});

test('a denied response is not counted as allowed', () => {
  assert.equal(isAllowed({ status: 403, body: { code: '42501' } }), false);
});

test('isDeniedStorage: any non-2xx is denied; a 2xx is not', () => {
  assert.equal(isDeniedStorage({ status: 400 }), true);
  assert.equal(isDeniedStorage({ status: 403 }), true);
  assert.equal(isDeniedStorage({ status: 200 }), false);
});
