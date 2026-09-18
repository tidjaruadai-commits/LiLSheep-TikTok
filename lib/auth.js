import crypto from 'node:crypto';

// Constant-time credential check. Fail-closed: empty configured password never matches.
export function checkLogin(user, pass, cfg) {
  if (!cfg.ownerPassword) return false;
  const eq = (a, b) => {
    const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  };
  const okUser = eq(user, cfg.ownerUser);
  const okPass = eq(pass, cfg.ownerPassword);
  return okUser && okPass;
}

// Tiny in-memory per-key failure counter for the login route.
export class RateLimiter {
  constructor({ max = 5, windowMs = 15 * 60 * 1000 } = {}) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  _fresh(key) { const h = this.hits.get(key); if (!h || Date.now() - h.first > this.windowMs) { const n = { first: Date.now(), count: 0 }; this.hits.set(key, n); return n; } return h; }
  blocked(key) { return this._fresh(key).count >= this.max; }
  fail(key) { this._fresh(key).count++; }
  reset(key) { this.hits.delete(key); }
}
