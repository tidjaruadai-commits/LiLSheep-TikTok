// Single source of truth for configuration. Read lazily so tests can set env first.
const MANDATORY = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_M039_JWT', 'SECRET_STORE_KEY', 'OWNER_PASSWORD'];

// URLs are trimmed: a pasted Vercel env var carried a trailing "\n", which Node's URL parser
// silently drops for requests but which we then stored verbatim inside every archived cover_url.
// Secrets/passwords are deliberately NOT trimmed — SECRET_STORE_KEY derives the token cipher key.
const url = (v) => String(v || '').trim().replace(/\/+$/, '');

export function getConfig() {
  const e = process.env;
  return {
    supabaseUrl: url(e.SUPABASE_URL),
    supabaseAnonKey: e.SUPABASE_ANON_KEY || '',   // apikey header only — inert without the Bearer JWT
    m039Jwt: e.SUPABASE_M039_JWT || '',             // Bearer — role m039_app
    secretStoreKey: e.SECRET_STORE_KEY || '',
    ownerUser: e.OWNER_USER || 'owner',
    ownerPassword: e.OWNER_PASSWORD || '',
    reportPilotBase: url(e.REPORT_PILOT_BASE) || 'https://api.tidjaruad.co',
    reportPilotKey: e.REPORT_PILOT_KEY || '',
    reportPilotClientId: e.REPORT_PILOT_CLIENT_ID || '',
    coversBucket: 'm039-covers',
  };
}

// Throw (refuse to boot) if any mandatory secret is missing — no insecure defaults.
export function requireEnv() {
  const missing = MANDATORY.filter((k) => !((process.env[k] || '').trim()));
  if (missing.length) {
    throw new Error(`Lilsheep-TikTok cannot boot — missing required env: ${missing.join(', ')}`);
  }
}
