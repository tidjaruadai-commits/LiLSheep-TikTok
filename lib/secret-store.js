import crypto from 'node:crypto';
import { dbFetch } from './db.js';

const SALT = 'm039-secret-store-v1';
const rawKey = () => process.env.SECRET_STORE_KEY || '';
const deriveKey = () => crypto.scryptSync(rawKey(), SALT, 32);

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(ciphertext) {
  try {
    const [iv, tag, data] = String(ciphertext).split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch { return null; }
}

export async function saveSecret(cfg, id, plaintext, fetchImpl = fetch) {
  const row = [{ id, ciphertext: encryptSecret(plaintext), updated_at: new Date().toISOString() }];
  const { status } = await dbFetch(cfg, '/rest/v1/m039_secrets?on_conflict=id',
    { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(row) }, fetchImpl);
  return status >= 200 && status < 300;
}

export async function loadSecret(cfg, id, fetchImpl = fetch) {
  const { status, body } = await dbFetch(cfg,
    `/rest/v1/m039_secrets?id=eq.${encodeURIComponent(id)}&select=ciphertext`, {}, fetchImpl);
  if (status < 200 || status >= 300 || !Array.isArray(body) || !body.length) return null;
  return decryptSecret(body[0].ciphertext);
}

export async function deleteSecret(cfg, id, fetchImpl = fetch) {
  const { status } = await dbFetch(cfg,
    `/rest/v1/m039_secrets?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl);
  return status >= 200 && status < 300;
}
