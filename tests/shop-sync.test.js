import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapShopResponse } from '../lib/shop-sync.js';

const api = {
  shops: [{
    shop_code: 'THLCHHWW37', shop_name: 'Lilsheep Shop',
    metrics: { gmv: 1000, orders: 10, units: 12, refunds: 50,
      gmv_by_channel: { live: 400, video: 500, product_card: 100 },
      visitors: 900, page_views: 2000, gross_revenue: 950 },
    top_products: [{ id: '1', name: 'A' }], live_sessions: [{ id: 's1' }],
  }],
  total: { shops_failed: 0 },
};

test('mapShopResponse maps a shop to a m039_shops upsert + a m039_shop_monthly row with the channel split', () => {
  const { shopUpserts, monthlyRows, synced, failed } = mapShopResponse('2026-09', api);
  assert.equal(synced, 1); assert.equal(failed, 0);
  assert.deepEqual(shopUpserts[0], { key: 'THLCHHWW37', name: 'Lilsheep Shop', shop_code: 'THLCHHWW37', sort: 0 });
  const r = monthlyRows[0];
  assert.equal(r.month, '2026-09'); assert.equal(r.shop_key, 'THLCHHWW37');
  assert.equal(r.gmv, 1000); assert.equal(r.orders, 10); assert.equal(r.refund, 50);
  assert.equal(r.gmv_live, 400); assert.equal(r.gmv_video, 500); assert.equal(r.gmv_product_card, 100);
  assert.deepEqual(r.top_products, [{ id: '1', name: 'A' }]);
  assert.deepEqual(r.live_sessions, [{ id: 's1' }]);
});

test('a shop row with error is not mapped and counts as failed', () => {
  const { synced, failed } = mapShopResponse('2026-09', { shops: [{ shop_code: 'X', error: 'boom' }], total: {} });
  assert.equal(synced, 0); assert.equal(failed, 1);
});

test('products/lives are omitted from the row when absent (so a light sync never nulls them)', () => {
  const { monthlyRows } = mapShopResponse('2026-09', { shops: [{ shop_code: 'Y', shop_name: 'Y', metrics: { gmv: 1 } }], total: {} });
  assert.ok(!('top_products' in monthlyRows[0]));
  assert.ok(!('live_sessions' in monthlyRows[0]));
});
