import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signHS256, decodeJWT } from '../lib/jwt.js';

const SECRET = 'legacy-supabase-jwt-secret-example';

test('signHS256 produces a 3-part token that decodes to the payload', () => {
  const token = signHS256({ role: 'm039_app', exp: 4102444800 }, SECRET);
  assert.equal(token.split('.').length, 3);
  const { header, payload } = decodeJWT(token);
  assert.equal(header.alg, 'HS256');
  assert.equal(header.typ, 'JWT');
  assert.equal(payload.role, 'm039_app');
  assert.equal(payload.exp, 4102444800);
});

test('signHS256 sets iat and is deterministic for identical payload+secret', () => {
  const p = { role: 'm039_app', iat: 1000, exp: 2000 };
  assert.equal(signHS256(p, SECRET), signHS256(p, SECRET));
});

test('a token signed with a different secret has a different signature', () => {
  const p = { role: 'm039_app', iat: 1, exp: 2 };
  assert.notEqual(signHS256(p, SECRET).split('.')[2], signHS256(p, 'other').split('.')[2]);
});

test('decodeJWT throws on a malformed token', () => {
  assert.throws(() => decodeJWT('not.a.jwt.token'));
  assert.throws(() => decodeJWT('onlyonepart'));
});
