import crypto from 'node:crypto';

// Constant-time credential check. Returns the session role — 'owner' (full access) or 'viewer'
// (read-only: requireOwner keeps it off the token and sync routes) — and '' for a bad login, which
// is falsy so callers read as before. Fail-closed: an account with no configured password never
// matches, so an unset OWNER_PASSWORD or a malformed VIEWERS entry cannot become an open door.
export function checkLogin(user, pass, cfg) {
  const eq = (a, b) => {
    const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  };
  if (cfg.ownerPassword && eq(user, cfg.ownerUser) && eq(pass, cfg.ownerPassword)) return 'owner';
  // Every viewer is compared, with no early return, so a wrong password costs the same work
  // whichever account it was aimed at.
  let viewer = false;
  for (const v of (cfg.viewers || [])) {
    if (v && v.pass && eq(user, v.user) && eq(pass, v.pass)) viewer = true;
  }
  return viewer ? 'viewer' : '';
}

// Tiny in-memory per-key failure counter for the login route.
export class RateLimiter {
  constructor({ max = 5, windowMs = 15 * 60 * 1000 } = {}) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  _fresh(key) { const h = this.hits.get(key); if (!h || Date.now() - h.first > this.windowMs) { const n = { first: Date.now(), count: 0 }; this.hits.set(key, n); return n; } return h; }
  blocked(key) { return this._fresh(key).count >= this.max; }
  fail(key) { this._fresh(key).count++; }
  reset(key) { this.hits.delete(key); }
}
