import crypto from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

// HS256-sign a JWT with node:crypto (no external dependency).
export function signHS256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { iat: Math.floor(Date.now() / 1000), ...payload };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(body)}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

export function decodeJWT(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const json = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  return { header: json(parts[0]), payload: json(parts[1]), signature: parts[2] };
}
