import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20260915_m039_video_cover.sql', import.meta.url), 'utf8');

test('adds a nullable cover_url column to m039_video_monthly (additive; if not exists)', () => {
  assert.match(sql, /alter table m039_video_monthly\s+add column if not exists cover_url text/i);
});
