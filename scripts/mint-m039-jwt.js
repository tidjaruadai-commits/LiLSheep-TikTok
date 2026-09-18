import { signHS256 } from '../lib/jwt.js';
import { pathToFileURL } from 'node:url';

// Build the m039_app claim set. exp is capped at 365 days regardless of requested window.
export function buildM039Claims({ now = Math.floor(Date.now() / 1000), days = 365 } = {}) {
  const capped = Math.min(days, 365);
  return { role: 'm039_app', iss: 'm039-lilsheep-tiktok', iat: now, exp: now + capped * 86400 };
}

// CLI: SUPABASE_JWT_SECRET=... node scripts/mint-m039-jwt.js [days]
function main() {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error("Set SUPABASE_JWT_SECRET (Report Pilot's LEGACY Supabase JWT secret) and rerun.");
    process.exit(1);
  }
  const days = Number(process.argv[2]) || 365;
  const token = signHS256(buildM039Claims({ days }), secret);
  console.error(`m039_app JWT (role=m039_app, exp in ${Math.min(days, 365)}d). Set as SUPABASE_M039_JWT:`);
  console.log(token); // stdout = just the token, so it can be piped
}

// Run main only when invoked directly, not when imported by the test.
// pathToFileURL handles Windows paths (backslashes) — a raw `file://${argv[1]}` compare is false on Windows.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
