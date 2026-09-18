import { test } from 'node:test';
import assert from 'node:assert/strict';

test('importing server.js with no required env throws the boot guard', async () => {
  const saved = { ...process.env };
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_M039_JWT', 'SECRET_STORE_KEY', 'OWNER_PASSWORD']) delete process.env[k];
  process.env.M039_NO_LISTEN = '1'; // don't bind a port during the test
  try {
    await assert.rejects(() => import('../server.js?first'), /cannot boot|required env/i);
  } finally { process.env = saved; }
});
