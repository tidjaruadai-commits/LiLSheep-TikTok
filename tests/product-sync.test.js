import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapProducts, syncProducts, syncProductImages, isPublicHttps, namesFromVideos, syncProductNames } from '../lib/product-sync.js';
import { TIKTOK_OUTSIDE_LOOKBACK, TIKTOK_APP_GROUP_RATE_LIMIT } from '../connectors/report-pilot.js';

const cfg = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', m039Jwt: 'j' };

function recorder(status = 201) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { calls.push({ url: String(url), method: opts.method, body: opts.body }); return { status, async text() { return ''; } }; };
  return { calls, fetchImpl };
}

test('mapProducts builds one row per product id, rounds money, defaults missing numbers to 0', () => {
  const rows = mapProducts('2026-09', [
    { id: 'p1', name: 'Sleep Well', gmv: 30000.456, orders: 300.4, items_sold: 410 },
    { id: 'p2', name: 'No sales fields', gmv: null, orders: null, items_sold: null },
    { id: 'p1', name: 'duplicate id', gmv: 1, orders: 1, items_sold: 1 },
    { id: '', name: 'no id', gmv: 5 },
  ]);
  assert.equal(rows.length, 2, 'duplicate and id-less rows dropped');
  assert.deepEqual(rows[0], { month: '2026-09', product_id: 'p1', name: 'Sleep Well', gmv: 30000.46, orders: 300, items_sold: 410 });
  assert.deepEqual(rows[1], { month: '2026-09', product_id: 'p2', name: 'No sales fields', gmv: 0, orders: 0, items_sold: 0 });
});

test('syncProducts upserts the month then deletes products this run no longer returned', async () => {
  const { calls, fetchImpl } = recorder();
  const client = { fetchShopProducts: async () => ({ version: '202509', truncated: false, products: [
    { id: 'p1', name: 'A', gmv: 100, orders: 1, items_sold: 1 }, { id: 'p2', name: 'B', gmv: 50, orders: 1, items_sold: 1 },
  ] }) };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results[0], { month: '2026-09', products: 2, gmv: 150, version: '202509', ok: true });

  const up = calls.find((c) => c.method === 'POST');
  assert.match(up.url, /\/m039_product_monthly\?on_conflict=month,product_id/);
  const body = JSON.parse(up.body);
  assert.equal(body.length, 2);
  assert.ok(body.every((r) => r.synced_at), 'every row carries this run stamp');

  const del = calls.find((c) => c.method === 'DELETE');
  assert.match(del.url, /m039_product_monthly\?month=eq\.2026-09&synced_at=lt\./);
  assert.ok(calls.indexOf(up) < calls.indexOf(del), 'upsert first, then the stale delete');
});

test('an empty list from TikTok is skipped, never allowed to delete the stored products', async () => {
  const { calls, fetchImpl } = recorder();
  const client = { fetchShopProducts: async () => ({ version: '202509', truncated: false, products: [] }) };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results[0], { month: '2026-09', products: 0, skipped: 'no-products' });
  assert.equal(calls.length, 0, 'no write and no delete');
});

test('a month past TikTok\'s lookback wall is skipped, not reported as a failure', async () => {
  const { fetchImpl } = recorder();
  const err = Object.assign(new Error('outside lookback'), { code: 'TT_ERROR', ttCode: TIKTOK_OUTSIDE_LOOKBACK });
  const client = { fetchShopProducts: async () => { throw err; } };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-01'], fetchImpl });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results[0], { month: '2026-01', skipped: 'outside-tiktok-window' });
});

test('an ordinary failure is an error, and one bad month does not stop the next', async () => {
  const { fetchImpl } = recorder();
  const client = { fetchShopProducts: async (cid, month) => {
    if (month === '2026-08') throw new Error('shop_products ใช้ไม่ได้ — 202509: boom | 202405: boom');
    return { version: '202405', truncated: false, products: [{ id: 'p1', name: 'A', gmv: 10, orders: 1, items_sold: 1 }] };
  } };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-08', '2026-09'], fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.results[0].error, /202509: boom/);
  assert.equal(res.results[1].ok, true);
});

test('a db write failure is reported as that month\'s error', async () => {
  const { fetchImpl } = recorder(500);
  const client = { fetchShopProducts: async () => ({ version: '202509', truncated: false, products: [{ id: 'p1', name: 'A', gmv: 10, orders: 1, items_sold: 1 }] }) };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.results[0].error, /HTTP 500/);
});

test('a truncated page is flagged in the result', async () => {
  const { fetchImpl } = recorder();
  const client = { fetchShopProducts: async () => ({ version: '202509', truncated: true, products: [{ id: 'p1', name: 'A', gmv: 10, orders: 1, items_sold: 1 }] }) };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.results[0].truncated, true);
});

test('a malformed month is rejected without calling TikTok', async () => {
  const { fetchImpl } = recorder();
  const client = { fetchShopProducts: async () => { throw new Error('must not be called'); } };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-13'], fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.results[0].error, 'bad month');
});

// ---- product pictures ----

const PUBLIC = 'https://x.supabase.co/storage/v1/object/public/m039-covers';

// A fake network: existing = product ids that already have a stored picture; imgs = url -> response.
function net({ existing = [], imgs = {}, storageStatus = 200, tableStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    const json = (status, body) => ({ status, headers: { get: () => 'application/json' }, async text() { return body == null ? '' : JSON.stringify(body); } });
    if (u.includes('/rest/v1/m039_product_monthly')) return json(201, null);   // the month's sales upsert + stale delete
    if (u.includes('/rest/v1/m039_product_images?select=')) return json(tableStatus, existing.map((id) => ({ product_id: id })));
    if (u.includes('/storage/v1/object/m039-covers/')) return { status: storageStatus, async text() { return ''; } };
    if (u.includes('/rest/v1/m039_product_images?on_conflict')) return json(201, null);
    if (imgs[u]) return imgs[u];
    return { status: 404, headers: { get: () => '' }, async arrayBuffer() { return new ArrayBuffer(0); } };
  };
  return { calls, fetchImpl };
}
const png = (type = 'image/png') => ({ status: 200, headers: { get: () => type }, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } });
const prods = (...ids) => ids.map((id) => ({ id, name: 'P' + id, gmv: 1 }));
const imgClient = (urls) => ({ fetchProductImage: async (cid, id) => ({ url: urls[id] ?? '', version: '202309' }) });

test('isPublicHttps accepts a CDN url and refuses http, bare IPs, localhost and internal hosts', () => {
  assert.equal(isPublicHttps('https://p16-oec.ibyteimg.com/a/b.jpg?x=1'), true);
  const bad = ['http://cdn.example.com/a.jpg', 'https://127.0.0.1/a', 'https://169.254.169.254/latest', 'https://10.0.0.5/a',
    'https://localhost/a', 'https://db.internal/a', 'https://printer.local/a', 'https://[::1]/a', 'https://nodots/a', 'not a url', ''];
  for (const url of bad) assert.equal(isPublicHttps(url), false, url);
});

test('pictures are fetched only for products with none, copied into OUR bucket, and only OUR url is stored', async () => {
  const { calls, fetchImpl } = net({ existing: ['1'], imgs: { 'https://cdn.example.com/p2.jpg': png() } });
  const out = await syncProductImages({ cfg, client: imgClient({ 2: 'https://cdn.example.com/p2.jpg' }), clientId: 'c1', products: prods('1', '2'), fetchImpl });
  assert.deepEqual(out, { withImage: 2, missing: 1, fetched: 1, noImage: 0, failed: 0, remaining: 0 });

  const up = calls.find((c) => c.url.endsWith('/storage/v1/object/m039-covers/products/2.jpg'));
  assert.ok(up, 'uploaded to products/<id>.jpg in the covers bucket');
  assert.equal(up.method, 'POST');
  assert.equal(up.headers['x-upsert'], 'true');
  assert.equal(up.headers['Content-Type'], 'image/png');

  const row = JSON.parse(calls.find((c) => c.url.includes('/m039_product_images?on_conflict=product_id')).body)[0];
  assert.equal(row.product_id, '2');
  assert.equal(row.image_url, PUBLIC + '/products/2.jpg', 'our public url, never the expiring TikTok one');
  assert.ok(!JSON.stringify(row).includes('cdn.example.com'));
  assert.ok(!calls.some((c) => c.url.includes('p1.jpg')), 'the product that already has a picture is not fetched again');
});

test('a product that has no picture counts as noImage and does not count toward giving up', async () => {
  const { fetchImpl } = net({ imgs: { 'https://cdn.example.com/p4.jpg': png() } });
  const client = { fetchProductImage: async (cid, id) => {
    if (id === '4') return { url: 'https://cdn.example.com/p4.jpg' };
    if (id === '1' || id === '2') throw new Error('boom');
    return { url: '' };
  } };
  // 1,2 fail, 3 has no picture (resets the run of failures), 4 succeeds, 5 has none
  const out = await syncProductImages({ cfg, client, clientId: 'c1', products: prods('1', '2', '3', '4', '5'), fetchImpl, maxFailuresInARow: 3 });
  assert.equal(out.fetched, 1);
  assert.equal(out.noImage, 2);
  assert.equal(out.failed, 2);
  assert.equal(out.stopped, undefined);
});

test('three failures in a row stop the loop and report the first reason (a missing API scope fails every product alike)', async () => {
  const { fetchImpl } = net();
  const seen = [];
  const client = { fetchProductImage: async (cid, id) => { seen.push(id); throw new Error(id === '1' ? 'no permission for product.read' : 'later'); } };
  const out = await syncProductImages({ cfg, client, clientId: 'c1', products: prods('1', '2', '3', '4', '5', '6'), fetchImpl });
  assert.deepEqual(seen, ['1', '2', '3'], 'gave up after three, did not hammer the rest');
  assert.equal(out.stopped, 'failures');
  assert.equal(out.error, 'no permission for product.read');
  assert.equal(out.remaining, 3);
});

test('the app-group rate limit stops the loop at once', async () => {
  const { fetchImpl } = net();
  const seen = [];
  const client = { fetchProductImage: async (cid, id) => { seen.push(id); throw Object.assign(new Error('rate limited'), { ttCode: TIKTOK_APP_GROUP_RATE_LIMIT }); } };
  const out = await syncProductImages({ cfg, client, clientId: 'c1', products: prods('1', '2', '3'), fetchImpl });
  assert.deepEqual(seen, ['1']);
  assert.equal(out.stopped, 'rate-limit');
});

test('the time budget stops new products and reports how many are left for the next run', async () => {
  const { fetchImpl } = net({ imgs: { 'https://cdn.example.com/a.jpg': png() } });
  const u = 'https://cdn.example.com/a.jpg';
  let t = 0;
  const out = await syncProductImages({ cfg, client: imgClient({ 1: u, 2: u, 3: u }), clientId: 'c1', products: prods('1', '2', '3'),
    fetchImpl, budgetMs: 1000, now: () => (t += 600) });
  assert.equal(out.stopped, 'budget');
  assert.equal(out.fetched, 1);
  assert.equal(out.remaining, 2);
});

test('a 200 that is not an image (an HTML error page) is refused, not stored as a picture', async () => {
  const { calls, fetchImpl } = net({ imgs: { 'https://cdn.example.com/p1.jpg': png('text/html; charset=utf-8') } });
  const out = await syncProductImages({ cfg, client: imgClient({ 1: 'https://cdn.example.com/p1.jpg' }), clientId: 'c1', products: prods('1'), fetchImpl });
  assert.equal(out.fetched, 0);
  assert.match(out.error, /ไม่ใช่รูป/);
  assert.ok(!calls.some((c) => c.url.includes('/storage/v1/object/')), 'nothing uploaded');
});

test('an image url that is not public https is never downloaded', async () => {
  const { calls, fetchImpl } = net();
  const out = await syncProductImages({ cfg, client: imgClient({ 1: 'https://169.254.169.254/latest/meta-data' }), clientId: 'c1', products: prods('1'), fetchImpl });
  assert.equal(out.fetched, 0);
  assert.match(out.error, /https สาธารณะ/);
  assert.ok(!calls.some((c) => c.url.includes('169.254')), 'the download was never attempted');
});

test('a failed bucket upload is a failure for that product and stores no row', async () => {
  const { calls, fetchImpl } = net({ storageStatus: 500, imgs: { 'https://cdn.example.com/p1.jpg': png() } });
  const out = await syncProductImages({ cfg, client: imgClient({ 1: 'https://cdn.example.com/p1.jpg' }), clientId: 'c1', products: prods('1'), fetchImpl });
  assert.equal(out.fetched, 0);
  assert.match(out.error, /HTTP 500/);
  assert.ok(!calls.some((c) => c.url.includes('/m039_product_images?on_conflict')), 'no row pointing at a file that is not there');
});

test('non-numeric product ids are skipped without being used in a request', async () => {
  const { calls, fetchImpl } = net();
  const seen = [];
  const client = { fetchProductImage: async (cid, id) => { seen.push(id); return { url: '' }; } };
  const out = await syncProductImages({ cfg, client, clientId: 'c1', products: [{ id: '../x' }, { id: '' }, { id: '12 3' }, { id: '77' }], fetchImpl });
  assert.deepEqual(seen, ['77']);
  assert.equal(out.missing, 1);
  assert.equal(calls.filter((c) => c.url.includes('products/')).length, 0);
});

test('an unreadable pictures table is reported, not thrown', async () => {
  const { fetchImpl } = net({ tableStatus: 500 });
  const out = await syncProductImages({ cfg, client: imgClient({}), clientId: 'c1', products: prods('1'), fetchImpl });
  assert.match(out.error, /HTTP 500/);
});

test('syncProducts runs the picture step after the sales are written, and a picture problem never fails the month', async () => {
  const { fetchImpl } = net();
  const client = {
    fetchShopProducts: async () => ({ version: '202509', truncated: false, products: [{ id: '5', name: 'A', gmv: 100, orders: 1, items_sold: 1 }] }),
    fetchProductImage: async () => { throw new Error('no permission for product.read'); },
  };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.ok, true, 'sales synced fine, so the run is ok');
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].images.error, 'no permission for product.read');
  assert.equal(res.results[0].imageWarning, 'รูปสินค้า: no permission for product.read');
  assert.equal(res.results[0].error, undefined);
});

test('the picture time budget is one pool for the whole call, not renewed for every month', async () => {
  const { fetchImpl } = net();
  let fetchedCount = 0;
  const client = {
    fetchShopProducts: async () => ({ version: '202509', truncated: false, products: [{ id: '5', name: 'A', gmv: 1, orders: 1, items_sold: 1 }] }),
    fetchProductImage: async () => { fetchedCount++; return { url: '' }; },
  };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-08', '2026-09'], fetchImpl, imageBudgetMs: 0 });
  assert.equal(fetchedCount, 0, 'with no budget left no picture is fetched for any month');
  assert.deepEqual(res.results.map((r) => r.images), [{ skipped: 'budget' }, { skipped: 'budget' }]);
});

// ---- product names (the sales list has none; shop videos list { id, name }) ----

test('namesFromVideos maps each product id to its first non-empty name', () => {
  const m = namesFromVideos([
    { products: [{ id: '1731721702603327489', name: '  Lilsheep  โปรตีนกระจก ' }, { id: '22', name: '' }] },
    { products: [{ id: '1731721702603327489', name: 'a later name is ignored' }, { id: '22', name: 'Second' }] },
    { products: 'not a list' }, null, { products: [{ id: 'not-digits', name: 'x' }, { name: 'no id' }] },
  ]);
  assert.deepEqual(m, { '1731721702603327489': 'Lilsheep โปรตีนกระจก', 22: 'Second' });
});

function nameNet({ known = [], tableStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body });
    const json = (status, body) => ({ status, async text() { return body == null ? '' : JSON.stringify(body); } });
    if (u.includes('/rest/v1/m039_product_names?select=')) return json(tableStatus, known.map((id) => ({ product_id: id })));
    return json(201, null);
  };
  return { calls, fetchImpl };
}

test('syncProductNames stores every name the video list gives that is not stored yet', async () => {
  const { calls, fetchImpl } = nameNet({ known: ['1'] });
  let pages;
  const client = { fetchShopVideos: async (cid, month, opts) => { pages = opts.maxPages; return [{ products: [{ id: '1', name: 'Known' }, { id: '2', name: 'Two' }, { id: '9', name: 'Other month' }] }]; } };
  const out = await syncProductNames({ cfg, client, clientId: 'c1', month: '2026-09', products: [{ id: '1' }, { id: '2' }, { id: '3' }], fetchImpl });
  assert.deepEqual(out, { added: 2, unnamed: 1 }, 'product 3 never appears in a clip');
  const body = JSON.parse(calls.find((c) => c.url.includes('m039_product_names?on_conflict=product_id')).body);
  assert.deepEqual(body.map((r) => [r.product_id, r.name]), [['2', 'Two'], ['9', 'Other month']]);
  assert.equal(pages, 5);
});

test('syncProductNames does not call TikTok when every product of the month already has a name', async () => {
  const { calls, fetchImpl } = nameNet({ known: ['1', '2'] });
  const client = { fetchShopVideos: async () => { throw new Error('must not be called'); } };
  const out = await syncProductNames({ cfg, client, clientId: 'c1', month: '2026-09', products: [{ id: '1' }, { id: '2' }], fetchImpl });
  assert.deepEqual(out, { added: 0, unnamed: 0 });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('syncProductNames reports an unreadable names table instead of throwing', async () => {
  const { fetchImpl } = nameNet({ tableStatus: 500 });
  const out = await syncProductNames({ cfg, client: { fetchShopVideos: async () => [] }, clientId: 'c1', month: '2026-09', products: [{ id: '1' }], fetchImpl });
  assert.match(out.error, /HTTP 500/);
});

test('syncProducts names the month after writing its sales, and a naming failure never fails the month', async () => {
  const { fetchImpl } = nameNet();
  const client = {
    fetchShopProducts: async () => ({ version: '202509', truncated: false, products: [{ id: '5', name: '', gmv: 100, orders: 1, items_sold: 1 }] }),
    fetchShopVideos: async () => { throw new Error('video list down'); },
  };
  const res = await syncProducts({ cfg, client, clientId: 'c1', months: ['2026-09'], fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.results[0].names.error, 'video list down');
  assert.equal(res.results[0].nameWarning, 'ชื่อสินค้า: video list down');
  assert.equal(res.results[0].error, undefined);
});
