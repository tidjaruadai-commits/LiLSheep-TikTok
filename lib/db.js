// The ONLY path to Supabase. Authenticates as role m039_app (Bearer JWT) with the anon key as
// the required apikey header. Fail-closed: no Bearer -> throw, never fall back to the anon role.
// Only the security-critical headers. Fail-closed: no Bearer -> throw.
export function buildHeaders(cfg) {
  if (!cfg.m039Jwt) throw new Error('db: refusing to call Supabase without the m039_app Bearer JWT (would degrade to anon)');
  return {
    apikey: cfg.supabaseAnonKey,
    Authorization: `Bearer ${cfg.m039Jwt}`,
  };
}

export function restUrl(cfg, table, query = '') {
  return `${cfg.supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`;
}

// path is an absolute Supabase path e.g. "/rest/v1/m039_shops?select=*" or "/storage/v1/object/...".
// buildHeaders() is spread LAST so a caller can never override apikey/Authorization; a default
// Content-Type is spread first so callers CAN set their own (e.g. an image upload) but it is optional.
export async function dbFetch(cfg, path, opts = {}, fetchImpl = fetch) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}), ...buildHeaders(cfg) };
  const resp = await fetchImpl(`${cfg.supabaseUrl}${path}`, { ...opts, headers });
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
}
