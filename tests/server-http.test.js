import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Set env BEFORE importing server.js (requireEnv runs at import). No real network is used —
// the dashboard route reads via dbFetch(fetch), but we never hit it unauthenticated.
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'a';
process.env.SUPABASE_M039_JWT = 'j';
process.env.SECRET_STORE_KEY = 'k';
process.env.OWNER_USER = 'owner';
process.env.OWNER_PASSWORD = 'pw';
process.env.M039_NO_LISTEN = '1';
const { app } = await import('../server.js?http-test');

function req(server, method, path, { headers = {}, body } = {}) {
  const addr = server.address();
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: addr.port, method, path, headers }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    if (body) r.write(body); r.end();
  });
}

test('server wiring: healthz open, API needs auth, login works, env.js leaks nothing', async () => {
  const server = http.createServer(app).listen(0);
  try {
    // healthz is open
    assert.equal((await req(server, 'GET', '/healthz')).status, 200);

    const home = await req(server, 'GET', '/');
    assert.equal(home.status, 303);   // serveRoot redirects unauth -> /login with 303 (Vercel-safe)
    assert.equal(home.headers.location, '/login');

    // unauthenticated API calls are 401 JSON (not a page redirect)
    const dash = await req(server, 'GET', '/api/dashboard?month=2026-09');
    assert.equal(dash.status, 401);
    const connectNoAuth = await req(server, 'POST', '/api/tiktok/connect', { headers: { 'content-type': 'application/json' }, body: '{"key":"rpt_x"}' });
    assert.equal(connectNoAuth.status, 401);

    // log in as the owner and capture the session cookie
    const login = await req(server, 'POST', '/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=owner&password=pw' });
    assert.equal(login.status, 303);   // 303 See Other after POST (so Vercel doesn't 307-re-POST the target)
    assert.equal(login.headers.location, '/');
    const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    assert.ok(cookie, 'a session cookie was set');

    // /env.js (behind auth) exposes ONLY { role } — no Supabase url/key/jwt
    const env = await req(server, 'GET', '/env.js', { headers: { cookie } });
    assert.equal(env.status, 200);
    assert.ok(!/supabase|SUPABASE|eyJ|x\.supabase/.test(env.body), 'no supabase url/key/jwt in env.js');
    assert.match(env.body, /window\.__ENV/);

    // authenticated owner reaches the connect route; a bad-format key is rejected 400 BEFORE any network
    const connect = await req(server, 'POST', '/api/tiktok/connect', { headers: { 'content-type': 'application/json', cookie }, body: '{"key":"garbage"}' });
    assert.equal(connect.status, 400);

    // /api/cron/sync is exempt from login BUT protected by CRON_SECRET (unset here) -> 401 "unauthorized"
    // (reaching the cron handler, not the requireAuth gate, proves the exemption).
    const cronNoSecret = await req(server, 'GET', '/api/cron/sync');
    assert.equal(cronNoSecret.status, 401);
    assert.match(cronNoSecret.body, /unauthorized/);
  } finally { server.close(); }
});
