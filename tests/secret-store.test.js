import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, saveSecret, loadSecret } from '../lib/secret-store.js';

process.env.SECRET_STORE_KEY = process.env.SECRET_STORE_KEY || 'test-secret-store-key';

test('encrypt/decrypt roundtrips and ciphertext is not plaintext', () => {
  const s = 'rpt_FakeToken-abcDEF-ghiJKL';
  const c = encryptSecret(s);
  assert.notEqual(c, s);
  assert.ok(!c.includes(s));
  assert.equal(decryptSecret(c), s);
});

test('each encryption uses a fresh IV', () => {
  assert.notEqual(encryptSecret('same'), encryptSecret('same'));
});

test('decryptSecret returns null on garbage', () => {
  assert.equal(decryptSecret('not-a-cipher'), null);
});

test('saveSecret writes ciphertext (not plaintext) to m039_secrets via db', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  let sent;
  const fakeFetch = async (url, opts) => { sent = { url, opts }; return { status: 201, async text() { return ''; } }; };
  const ok = await saveSecret(cfg, 'tiktok', 'rpt_secret_value', fakeFetch);
  assert.equal(ok, true);
  assert.match(sent.url, /\/rest\/v1\/m039_secrets/);
  const body = JSON.parse(sent.opts.body)[0];
  assert.equal(body.id, 'tiktok');
  assert.ok(!JSON.stringify(body).includes('rpt_secret_value'), 'plaintext must not be sent');
  assert.equal(decryptSecret(body.ciphertext), 'rpt_secret_value');
});

test('loadSecret decrypts the row returned by db', async () => {
  const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };
  const cipher = encryptSecret('rpt_back');
  const fakeFetch = async () => ({ status: 200, async text() { return JSON.stringify([{ ciphertext: cipher }]); } });
  assert.equal(await loadSecret(cfg, 'tiktok', fakeFetch), 'rpt_back');
});
