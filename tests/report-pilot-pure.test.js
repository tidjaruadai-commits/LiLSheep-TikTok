import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthRange, normalizeKey, looksLikeKey, classifyAds, normalizeInclude, monthDateRange } from '../connectors/report-pilot.js';

test('normalizeInclude keeps only products/lives (gateway 422s on anything else), stable order, empty by default', () => {
  assert.equal(normalizeInclude(), '');
  assert.equal(normalizeInclude(''), '');
  assert.equal(normalizeInclude('lives'), 'lives');
  assert.equal(normalizeInclude(' LIVES , products ,bogus,,'), 'products,lives');
  assert.equal(normalizeInclude('bogus'), '');
});

test('monthRange returns inclusive start, EXCLUSIVE end (1st of next month)', () => {
  assert.deepEqual(monthRange('2026-09'), { start: '2026-09-01', end: '2026-10-01' });
  assert.deepEqual(monthRange('2026-12'), { start: '2026-12-01', end: '2027-01-01' });
  assert.equal(monthRange('nope'), null);
});

test('normalizeKey strips whitespace and repairs a broken rpt prefix', () => {
  assert.equal(normalizeKey('  rpt_abc def '), 'rpt_abcdef');
  assert.equal(normalizeKey('rpt abc'), 'rpt_abc');
});

test('looksLikeKey accepts rpt_ tokens of reasonable length', () => {
  assert.equal(looksLikeKey('rpt_' + 'a'.repeat(24)), true);
  assert.equal(looksLikeKey('nope'), false);
});

test('classifyAds: 422 no-campaign detail is noData; other 422 is error; 2xx is ok', () => {
  assert.equal(classifyAds(422, { detail: 'บัญชีนี้ไม่มีแคมเปญในเดือนนี้' }), 'noData');
  assert.equal(classifyAds(422, { detail: 'field required' }), 'error');
  assert.equal(classifyAds(200, {}), 'ok');
  assert.equal(classifyAds(500, {}), 'error');
});

test('monthDateRange returns an INCLUSIVE start/end (last day of month) for the gmv_max report endpoint', () => {
  assert.deepEqual(monthDateRange('2026-08'), { start_date: '2026-08-01', end_date: '2026-08-31' });
  assert.deepEqual(monthDateRange('2026-09'), { start_date: '2026-09-01', end_date: '2026-09-30' });
  assert.deepEqual(monthDateRange('2026-12'), { start_date: '2026-12-01', end_date: '2026-12-31' });   // Dec
});

test('monthDateRange handles February leap/non-leap years correctly', () => {
  assert.deepEqual(monthDateRange('2024-02'), { start_date: '2024-02-01', end_date: '2024-02-29' });   // leap
  assert.deepEqual(monthDateRange('2026-02'), { start_date: '2026-02-01', end_date: '2026-02-28' });   // non-leap
  assert.deepEqual(monthDateRange('2000-02'), { start_date: '2000-02-01', end_date: '2000-02-29' });   // div-400 leap
  assert.deepEqual(monthDateRange('1900-02'), { start_date: '1900-02-01', end_date: '1900-02-28' });   // div-100 non-leap
});

test('monthDateRange returns null for bad input', () => {
  assert.equal(monthDateRange('nope'), null);
  assert.equal(monthDateRange('2026-13'), null);
  assert.equal(monthDateRange('2026-00'), null);
  assert.equal(monthDateRange(''), null);
  assert.equal(monthDateRange(undefined), null);
});
