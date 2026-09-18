import { getConfig } from '../lib/env.js';
import { dbFetch } from '../lib/db.js';
import { pathToFileURL } from 'node:url';

// A response is DENIED only when Postgres refused it: 403 + SQLSTATE 42501.
export function isDenied({ status, body }) {
  return status === 403 && !!body && (body.code === '42501' || /permission denied/i.test(body.message || ''));
}
// ALLOWED = a 2xx that actually went through (200/201/204), NOT a denial.
export function isAllowed({ status, body }) {
  return status >= 200 && status < 300 && !isDenied({ status, body });
}
// Storage-api denials don't use PostgREST's {code:42501} shape (they return {statusCode,error,message}
// with an RLS message, often HTTP 400). For storage, treat ANY non-2xx as denied.
export function isDeniedStorage({ status }) {
  return !(status >= 200 && status < 300);
}

// --- live gate (run against the real DB after the migration + JWT are in place) ---
async function anonGet(cfg, table) {
  const headers = { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${cfg.supabaseAnonKey}` };
  const resp = await fetch(`${cfg.supabaseUrl}/rest/v1/${table}?select=*&limit=1`, { headers });
  const text = await resp.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: resp.status, body };
}

async function main() {
  const cfg = getConfig();
  const fails = [];
  const mustDeny = async (label, path, opts) => {
    const r = await dbFetch(cfg, path, opts);
    const ok = isDenied(r);
    console.log(`${ok ? 'PASS' : 'FAIL'}  denied: ${label}  (status ${r.status})`);
    if (!ok) fails.push(label);
  };
  const mustAllow = async (label, path, opts) => {
    const r = await dbFetch(cfg, path, opts);
    const ok = isAllowed(r);
    console.log(`${ok ? 'PASS' : 'FAIL'}  allowed: ${label}  (status ${r.status})`);
    if (!ok) fails.push(label);
  };
  // For calls whose denial isn't PostgREST-shaped (Storage RLS, or an rpc that returns 404 on an
  // arg-signature mismatch): any non-2xx means "not successfully executed" = rejected.
  const mustReject = async (label, path, opts) => {
    const r = await dbFetch(cfg, path, opts);
    const ok = isDeniedStorage(r);
    console.log(`${ok ? 'PASS' : 'FAIL'}  rejected: ${label}  (status ${r.status})`);
    if (!ok) fails.push(label);
  };
  const mustDenyStorage = mustReject;   // storage cross-bucket probe uses the same non-2xx check

  // Negative: m039_app must be denied on core tables + a public-EXECUTE rpc.
  await mustDeny('read clients', '/rest/v1/clients?select=id&limit=1');
  await mustDeny('read mcp_tokens', '/rest/v1/mcp_tokens?select=id&limit=1');
  await mustDeny('read av_orders (RLS-off)', '/rest/v1/av_orders?select=*&limit=1');
  // The rpc is NOT security-definer (verified), so it can't escalate; any non-2xx (403 denied, or
  // 404 for an arg-signature mismatch) proves m039_app did not successfully run privileged code.
  await mustReject('call rpc sync_client_accounts', '/rest/v1/rpc/sync_client_accounts', { method: 'POST', body: '{}' });

  // Positive: m039_app succeeds on its OWN table. Use m039_shops (no outbound FK) so the probe cannot
  // fail on a foreign-key violation; m039_shop_monthly.shop_key REFERENCES m039_shops, so inserting
  // there first would 409 on a clean DB.
  await mustAllow('read m039_shops', '/rest/v1/m039_shops?select=*&limit=1');
  await mustAllow('write m039_shops', '/rest/v1/m039_shops', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ key: '__containment_probe__', name: 'containment probe', sort: -1 }]),
  });

  // Storage: m039_app may write its own bucket, and MUST be refused on another bucket.
  await mustAllow('upload to m039-covers', `/storage/v1/object/${cfg.coversBucket}/__probe__.txt`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'true' }, body: 'probe',
  });
  await mustDenyStorage('upload to another bucket (reports)', '/storage/v1/object/reports/__probe__.txt', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'true' }, body: 'probe',
  });

  // Anti-regression: the ANON key alone must NOT read m039_secrets (proves the REVOKE landed).
  // Any 2xx here — including 200 [] — is a FAIL; only a non-2xx (denied/unauthorized) passes.
  const anon = await anonGet(cfg, 'm039_secrets');
  const anonOk = !(anon.status >= 200 && anon.status < 300);
  console.log(`${anonOk ? 'PASS' : 'FAIL'}  anon key blocked from m039_secrets  (status ${anon.status})`);
  if (!anonOk) fails.push('anon reads m039_secrets');

  // clean up probe artifacts (best-effort).
  await dbFetch(cfg, "/rest/v1/m039_shops?key=eq.__containment_probe__", { method: 'DELETE' }).catch(() => {});
  await dbFetch(cfg, `/storage/v1/object/${cfg.coversBucket}/__probe__.txt`, { method: 'DELETE' }).catch(() => {});

  if (fails.length) {
    console.error(`\nCONTAINMENT FAILED (${fails.length}): ${fails.join(', ')}`);
    console.error('Do NOT connect the rpt_ token to live data until this passes.');
    process.exit(1);
  }
  console.log('\nCONTAINMENT OK — m039_app is confined to m039_* + m039-covers.');
}

// pathToFileURL handles Windows paths — a raw `file://${argv[1]}` compare is false on Windows.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
