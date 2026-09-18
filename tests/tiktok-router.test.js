import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createTikTokController, createTikTokRouter } from '../routes/tiktok.js';

function reqJson(server, method, path, body) {
  const { port } = server.address();
  return new Promise((resolve) => {
    const headers = body ? { 'content-type': 'application/json' } : {};
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    if (body) r.write(body);
    r.end();
  });
}

test('connect stores a normalized key and status reports connected', async () => {
  const saved = {};
  const deps = {
    cfg: { reportPilotBase: 'https://api.tidjaruad.co' },
    saveKey: async (k) => { saved.k = k; return true; },
    loadKey: async () => saved.k || '',
    makeClient: () => ({ getClientId: async () => 'uuid-1' }),
  };
  const ctrl = createTikTokController(deps);
  const r = await ctrl.connect('  rpt_' + 'a'.repeat(24) + '  ');
  assert.equal(r.ok, true);
  assert.equal(saved.k, 'rpt_' + 'a'.repeat(24));   // trimmed/normalized
  assert.equal((await ctrl.status()).connected, true);
});

test('connect rejects a token that does not look like an rpt_ key', async () => {
  const ctrl = createTikTokController({ cfg: {}, saveKey: async () => true, loadKey: async () => '', makeClient: () => ({}) });
  const r = await ctrl.connect('garbage');
  assert.equal(r.ok, false);
});

test('sync hands the controller-built client to each job, in order (shop, ads, gmvmax, videos, covers)', async () => {
  const ran = [];
  const theClient = { getAdvertiserIds: async () => ['7218'], getClientId: async () => 'uuid-1' };
  const ctrl = createTikTokController({
    cfg: {}, saveKey: async () => true, loadKey: async () => 'rpt_' + 'a'.repeat(24),
    makeClient: () => theClient,
    syncShop: async ({ client, month }) => { ran.push(['shop', client === theClient, month]); return { ok: true }; },
    syncAds: async ({ client, advertiserIds, months }) => { ran.push(['ads', client === theClient, advertiserIds, months]); return { ok: true }; },
    syncGmvMax: async ({ client, advertiserIds, months }) => { ran.push(['gmvmax', client === theClient, advertiserIds, months]); return { ok: true }; },
    syncVideos: async ({ client, clientId, advertiserIds, months }) => { ran.push(['videos', client === theClient, clientId, advertiserIds, months]); return { ok: true }; },
    syncAffiliate: async ({ client, clientId, months }) => { ran.push(['affiliate', client === theClient, clientId, months]); return { ok: true }; },
    archiveCovers: async () => { ran.push(['cover']); return { ok: true }; },
  });
  const r = await ctrl.sync(['2026-09']);
  assert.equal(r.ok, true);
  assert.deepEqual(ran[0], ['shop', true, '2026-09']);
  assert.deepEqual(ran[1], ['ads', true, ['7218'], ['2026-09']]);
  assert.deepEqual(ran[2], ['gmvmax', true, ['7218'], ['2026-09']]);
  assert.deepEqual(ran[3], ['videos', true, 'uuid-1', ['7218'], ['2026-09']]);
  assert.deepEqual(ran[4], ['affiliate', true, 'uuid-1', ['2026-09']]);
  assert.deepEqual(ran[5], ['cover']);
});

test('sync keeps going when one step fails: later steps still run (progress persists) and the error is reported', async () => {
  const ran = [];
  const ctrl = createTikTokController({
    cfg: {}, saveKey: async () => true, loadKey: async () => 'rpt_' + 'a'.repeat(24),
    makeClient: () => ({ getAdvertiserIds: async () => ['7218'] }),
    syncShop: async ({ month }) => { if (month === '2026-08') throw new Error('gateway stalled'); ran.push(['shop', month]); return { ok: true, month }; },
    syncAds: async ({ months }) => { ran.push(['ads', months]); return { ok: true }; },
    syncGmvMax: async ({ months }) => { ran.push(['gmvmax', months]); return { ok: true }; },
    archiveCovers: async () => { ran.push(['cover']); return { ok: true }; },
  });
  const r = await ctrl.sync(['2026-09', '2026-08']);
  assert.deepEqual(ran, [['shop', '2026-09'], ['ads', ['2026-09', '2026-08']], ['gmvmax', ['2026-09', '2026-08']], ['cover']]);   // 2026-08 failed, the rest ran
  assert.equal(r.ok, false);
  assert.match(r.error, /2026-08.*gateway stalled/);
  assert.deepEqual(r.errors, ['shop 2026-08: gateway stalled']);
  assert.ok(r.lastSync, 'partial progress still counts as a sync');
  assert.equal((await ctrl.status()).lastSync, r.lastSync);
});

test('sync passes a normalized include through to the shop job; default is none', async () => {
  const seen = [];
  const ctrl = createTikTokController({
    cfg: {}, saveKey: async () => true, loadKey: async () => 'rpt_' + 'a'.repeat(24),
    makeClient: () => ({ getAdvertiserIds: async () => [] }),
    syncShop: async ({ month, include }) => { seen.push([month, include]); return { ok: true }; },
    syncAds: async () => { throw new Error('must not run with no advertisers'); },
    archiveCovers: async () => ({ ok: true }),
  });
  const a = await ctrl.sync(['2026-09']);
  const b = await ctrl.sync(['2026-09'], { include: 'lives,bogus' });
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.deepEqual(seen, [['2026-09', ''], ['2026-09', 'lives']]);
  assert.deepEqual(b.advertiserIds, []);
});

test('sync skips the gmvmax step (like ads) when there are no advertisers, and never breaks the run when it fails', async () => {
  const ran = [];
  const ctrl = createTikTokController({
    cfg: {}, saveKey: async () => true, loadKey: async () => 'rpt_' + 'a'.repeat(24),
    makeClient: () => ({ getAdvertiserIds: async () => ['7218'] }),
    syncShop: async () => { ran.push('shop'); return { ok: true }; },
    syncAds: async () => { ran.push('ads'); return { ok: true }; },
    syncGmvMax: async () => { throw new Error('gmv_max gateway 500'); },
    archiveCovers: async () => { ran.push('cover'); return { ok: true }; },
  });
  const r = await ctrl.sync(['2026-09']);
  assert.deepEqual(ran, ['shop', 'ads', 'cover'], 'covers still ran after gmvmax failed');
  assert.equal(r.ok, false);
  assert.match(r.error, /gmvmax.*gmv_max gateway 500/);
});

test('sync gives the cover archive only the time left in its budget, and skips it when none is left', async () => {
  const seen = [];
  const mk = (budgetMs, shopDelayMs) => createTikTokController({
    cfg: {}, saveKey: async () => true, loadKey: async () => 'rpt_' + 'a'.repeat(24),
    makeClient: () => ({ getAdvertiserIds: async () => [] }),
    syncShop: async () => { await new Promise((r) => setTimeout(r, shopDelayMs)); return { ok: true }; },
    syncAds: async () => ({ ok: true }),
    archiveCovers: async (opts) => { seen.push(opts); return { ok: true, archived: 0 }; },
  });
  const a = await mk(10_000, 0).sync(['2026-09'], { budgetMs: 10_000 });
  assert.equal(a.ok, true);
  assert.ok(seen[0].budgetMs > 0 && seen[0].budgetMs <= 10_000, `covers get the remaining budget, got ${seen[0].budgetMs}`);
  const b = await mk(0, 30).sync(['2026-09'], { budgetMs: 10 });   // shop alone overran the budget
  assert.equal(seen.length, 1, 'archiveCovers not called when the budget is spent');
  assert.equal(b.covers.skipped, 'budget');
  assert.equal(b.ok, true, 'a skipped cover pass is not an error — the next run picks it up');
});

test('POST /api/tiktok/sync forwards months + include from the body to the controller', async () => {
  let got;
  const controller = { status: async () => ({}), connect: async () => ({ ok: true }), sync: async (months, opts) => { got = [months, opts]; return { ok: true }; } };
  const app = express();
  app.use(express.json());
  app.use('/api/tiktok', createTikTokRouter(controller, { requireOwner: (req, res, next) => next() }));
  const server = http.createServer(app).listen(0);
  try {
    const r = await reqJson(server, 'POST', '/api/tiktok/sync', JSON.stringify({ months: ['2026-09'], include: 'lives' }));
    assert.equal(r.status, 200);
    assert.deepEqual(got, [['2026-09'], { include: 'lives' }]);
  } finally { server.close(); }
});

test('createTikTokRouter: a rejecting controller.status returns 500, never an unhandled crash', async () => {
  const controller = {
    status: async () => { throw new Error('db unreachable'); },
    connect: async () => ({ ok: true }),
    sync: async () => ({ ok: true }),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/tiktok', createTikTokRouter(controller, { requireOwner: (req, res, next) => next() }));
  const server = http.createServer(app).listen(0);
  try {
    const r = await reqJson(server, 'GET', '/api/tiktok/status');
    assert.equal(r.status, 500);   // handled -> 500 JSON, NOT a hung request or a process crash
  } finally { server.close(); }
});

test('createTikTokRouter: a rejecting controller.connect returns 500, not a crash', async () => {
  const controller = { status: async () => ({}), connect: async () => { throw new Error('save failed'); }, sync: async () => ({}) };
  const app = express();
  app.use(express.json());
  app.use('/api/tiktok', createTikTokRouter(controller, { requireOwner: (req, res, next) => next() }));
  const server = http.createServer(app).listen(0);
  try {
    const r = await reqJson(server, 'POST', '/api/tiktok/connect');
    assert.equal(r.status, 500);
  } finally { server.close(); }
});
