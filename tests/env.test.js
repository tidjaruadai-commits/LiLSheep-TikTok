import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, requireEnv, parseViewers } from '../lib/env.js';

function withEnv(vars, fn) {
  const saved = { ...process.env };
  try { Object.assign(process.env, vars); return fn(); }
  finally { process.env = saved; }
}

test('getConfig reads values from the environment', () => {
  withEnv({ SUPABASE_URL: 'https://x.supabase.co', REPORT_PILOT_BASE: '' }, () => {
    const c = getConfig();
    assert.equal(c.supabaseUrl, 'https://x.supabase.co');
    assert.equal(c.reportPilotBase, 'https://api.tidjaruad.co'); // default
  });
});

test('getConfig trims whitespace/newlines around URL values (a pasted Vercel env var carried a trailing \\n into every stored cover_url)', () => {
  withEnv({ SUPABASE_URL: ' https://x.supabase.co/\n', REPORT_PILOT_BASE: 'https://api.example.com \n' }, () => {
    const c = getConfig();
    assert.equal(c.supabaseUrl, 'https://x.supabase.co');
    assert.equal(c.reportPilotBase, 'https://api.example.com');
  });
  withEnv({ REPORT_PILOT_BASE: ' \n' }, () => assert.equal(getConfig().reportPilotBase, 'https://api.tidjaruad.co'));
});

test('requireEnv throws listing every missing mandatory var', () => {
  withEnv(
    { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_M039_JWT: '', SECRET_STORE_KEY: '', OWNER_PASSWORD: '' },
    () => {
      // node:assert throws() does NOT return the error — validate it via the validator callback.
      assert.throws(() => requireEnv(), (err) => {
        for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_M039_JWT', 'SECRET_STORE_KEY', 'OWNER_PASSWORD']) {
          assert.ok(err.message.includes(k), `message should mention ${k}`);
        }
        return true;
      });
    }
  );
});

test('requireEnv passes when all mandatory vars are present', () => {
  withEnv(
    { SUPABASE_URL: 'u', SUPABASE_ANON_KEY: 'a', SUPABASE_M039_JWT: 'j', SECRET_STORE_KEY: 's', OWNER_PASSWORD: 'p' },
    () => assert.doesNotThrow(() => requireEnv())
  );
});

test('parseViewers reads "name:password" pairs split by comma or newline, dropping half-written entries', () => {
  assert.deepEqual(parseViewers('somchai:s3cret,malee:hunter2'),
    [{ user: 'somchai', pass: 's3cret' }, { user: 'malee', pass: 'hunter2' }]);
  assert.deepEqual(parseViewers(' somchai : s3cret \n malee:hunter2 '),
    [{ user: 'somchai', pass: ' s3cret' }, { user: 'malee', pass: 'hunter2' }]);
  // only the FIRST colon splits, so a password may contain one
  assert.deepEqual(parseViewers('a:pa:ss'), [{ user: 'a', pass: 'pa:ss' }]);
  // no name, no password, or no colon at all -> dropped, never an account with a blank half
  assert.deepEqual(parseViewers('nopassword:,:nouser,plain,,'), []);
  assert.deepEqual(parseViewers(''), []);
  assert.deepEqual(parseViewers(undefined), []);
});
