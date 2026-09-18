import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAdsResponse, keepArchivedCovers, campaignTypeMap, aggregateEngagement, mergeEngagement } from '../lib/ads-sync.js';

test('keepArchivedCovers: a re-sync keeps our stable m039-covers URL instead of the fresh expiring CDN one', () => {
  // Live 2026-09-12: the second sync overwrote 84 archived cover_urls with new CDN links, so the cover
  // archive re-downloaded every clip again (119 rows, ~200s) and hit the run budget.
  const adRows = [{ ad_id: 'a1', cover_url: 'https://p16-tiktokcdn.com/new.jpg', spend: 1 }, { ad_id: 'a2', cover_url: 'https://p16-tiktokcdn.com/a2.jpg', spend: 2 }];
  const existing = [
    { ad_id: 'a1', cover_url: 'https://x.supabase.co/storage/v1/object/public/m039-covers/a1.jpg' },
    { ad_id: 'zz', cover_url: 'https://x.supabase.co/storage/v1/object/public/m039-covers/zz.jpg' },
    { ad_id: 'a2', cover_url: 'https://p16-tiktokcdn.com/old-cdn.jpg' },   // not archived -> fresh CDN wins
  ];
  const out = keepArchivedCovers(adRows, existing);
  assert.equal(out[0].cover_url, existing[0].cover_url);
  assert.equal(out[0].spend, 1, 'other fields untouched');
  assert.equal(out[1].cover_url, adRows[1].cover_url);
  assert.deepEqual(keepArchivedCovers(adRows, []), adRows);
  assert.deepEqual(keepArchivedCovers(adRows, null), adRows);
});

const data = {
  client_name: 'Lilsheep',
  results_by_type: [{ type: 'conversion', label: 'Conversions' }],
  projects: [{
    campaign_type: 'conversion', spend: 100, impressions: 5000, clicks: 200, results: 8,
    engagement: 30, video_views: 400, onsite_gmv: 900, video_6s: 250, video_15s: 120, video_completed: 60,
    campaigns: [{ campaign_id: 'c1' }, { campaign_id: 'c2' }],
    top_cost_ads: [
      { ad_id: 'a1', ad_name: 'Ad 1', caption: 'hi', thumbnail_url: 't', video_url: 'v', spend: 60, results: 5, like: 3, comment: 1, share: 1, follow: 0, favorite: 0, profile_visit: 2, video_views: 300, deep_score: 7, onsite_gmv: 500 },
      { ad_id: 'a1', ad_name: 'dup', spend: 999 },
    ],
  }],
};

test('mapAdsResponse builds one monthly row per campaign_type with the type label', () => {
  const { monthlyRows } = mapAdsResponse('2026-09', '7218', data);
  assert.equal(monthlyRows.length, 1);
  assert.equal(monthlyRows[0].campaign_type, 'conversion');
  assert.equal(monthlyRows[0].result_label, 'Conversions');
  assert.equal(monthlyRows[0].spend, 100);
  assert.equal(monthlyRows[0].gmv_ads, 900);
});

test('mapAdsResponse AGGREGATES projects sharing a campaign_type into ONE row (table PK is month+advertiser+type)', () => {
  // Live failure 2026-09-12: Report Pilot returned several projects of the same campaign_type; one row
  // per project put duplicate PKs in a single upsert and Postgres rejected the whole batch (21000).
  const d = {
    results_by_type: [{ type: 'conversion', label: 'Conversions' }],
    projects: [
      { campaign_type: 'conversion', project_name: 'Conv A', spend: 100, impressions: 5000, clicks: 200, results: 8, engagement: 30, video_views: 400, onsite_gmv: 900, top_cost_ads: [{ ad_id: 'a1', spend: 60 }] },
      { campaign_type: 'conversion', project_name: 'Conv B', spend: '50.5', impressions: 1000, clicks: 10, results: 2, engagement: 5, video_views: 100, onsite_gmv: 100.25, top_cost_ads: [{ ad_id: 'a2', spend: 40 }] },
      { campaign_type: 'reach', project_name: 'Reach', spend: 1, top_cost_ads: [] },
    ],
  };
  const { monthlyRows, adRows } = mapAdsResponse('2026-09', '7218', d);
  assert.equal(monthlyRows.length, 2);
  const conv = monthlyRows.find((r) => r.campaign_type === 'conversion');
  assert.equal(conv.spend, 150.5); assert.equal(conv.impressions, 6000); assert.equal(conv.clicks, 210);
  assert.equal(conv.results, 10); assert.equal(conv.engagement, 35); assert.equal(conv.video_views, 500);
  assert.equal(conv.gmv_ads, 1000.25); assert.equal(conv.result_label, 'Conversions');
  const reach = monthlyRows.find((r) => r.campaign_type === 'reach');
  assert.equal(reach.spend, 1); assert.equal(reach.result_label, 'Reach');   // no type label -> project name
  const pks = new Set(monthlyRows.map((r) => `${r.month}|${r.advertiser_id}|${r.campaign_type}`));
  assert.equal(pks.size, monthlyRows.length, 'no duplicate PK inside one upsert payload');
  assert.deepEqual(adRows.map((a) => a.ad_id).sort(), ['a1', 'a2']);   // clips from every project kept
});

test('mapAdsResponse flattens ads and dedups by ad_id; engagement is summed', () => {
  const { adRows } = mapAdsResponse('2026-09', '7218', data);
  assert.equal(adRows.length, 1);            // dup a1 dropped
  assert.equal(adRows[0].ad_id, 'a1');
  assert.equal(adRows[0].gmv, 500);
  assert.equal(adRows[0].engagement, 3 + 1 + 1 + 0 + 0 + 2);
  assert.equal(adRows[0].result_label, 'Conversions');
});

test('mapAdsResponse carries per-objective video_6s / video_15s / video_completed and seeds engagement fields at 0', () => {
  const { monthlyRows } = mapAdsResponse('2026-09', '7218', data);
  const r = monthlyRows[0];
  assert.equal(r.video_6s, 250);
  assert.equal(r.video_15s, 120);
  assert.equal(r.video_completed, 60);
  // the per-objective like/comment/share/profile split is filled later by the raw report (mergeEngagement)
  assert.equal(r.likes, 0); assert.equal(r.comments, 0); assert.equal(r.shares, 0); assert.equal(r.profile_visits, 0);
});

test('mapAdsResponse SUMS video_6s/15s/completed across projects sharing a campaign_type', () => {
  const d = { projects: [
    { campaign_type: 'video_view', spend: 1, video_6s: 100, video_15s: 40, video_completed: 10, top_cost_ads: [] },
    { campaign_type: 'video_view', spend: 2, video_6s: 50, video_15s: 20, video_completed: 5, top_cost_ads: [] },
  ] };
  const { monthlyRows } = mapAdsResponse('2026-09', '7218', d);
  assert.equal(monthlyRows.length, 1);
  assert.equal(monthlyRows[0].video_6s, 150);
  assert.equal(monthlyRows[0].video_15s, 60);
  assert.equal(monthlyRows[0].video_completed, 15);
});

test('campaignTypeMap maps every campaign_id to its objective, across all projects', () => {
  const d = { projects: [
    { campaign_type: 'video_view', campaigns: [{ campaign_id: 'c1' }, { campaign_id: 'c2' }] },
    { campaign_type: 'visit_profile', campaigns: [{ campaign_id: 'c3' }] },
    { campaign_type: 'conversion', campaigns: [] },
    { campaign_type: 'unknown-less', campaigns: null },
  ] };
  const m = campaignTypeMap(d);
  assert.deepEqual(m, { c1: 'video_view', c2: 'video_view', c3: 'visit_profile' });
  assert.deepEqual(campaignTypeMap(null), {});
  assert.deepEqual(campaignTypeMap({}), {});
});

test('aggregateEngagement sums raw report rows into per-objective totals; unmapped campaigns are ignored', () => {
  const typeMap = { c1: 'video_view', c2: 'video_view', c3: 'visit_profile' };
  const rows = [
    { dimensions: { campaign_id: 'c1' }, metrics: { likes: '100', comments: '2', shares: '3', profile_visits: '40' } },
    { dimensions: { campaign_id: 'c2' }, metrics: { likes: '50', comments: '1', shares: '0', profile_visits: '10' } },
    { dimensions: { campaign_id: 'c3' }, metrics: { likes: '7', comments: '0', shares: '1', profile_visits: '900' } },
    { dimensions: { campaign_id: 'zz' }, metrics: { likes: '999', comments: '9', shares: '9', profile_visits: '9' } }, // not in map -> skipped
  ];
  const agg = aggregateEngagement(rows, typeMap);
  assert.deepEqual(agg.video_view, { likes: 150, comments: 3, shares: 3, profile_visits: 50 });
  assert.deepEqual(agg.visit_profile, { likes: 7, comments: 0, shares: 1, profile_visits: 900 });
  assert.ok(!('zz' in agg));
  assert.deepEqual(aggregateEngagement(null, typeMap), {});
});

test('mergeEngagement folds per-objective engagement into the matching monthly rows only', () => {
  const monthly = [
    { campaign_type: 'video_view', spend: 5, likes: 0, comments: 0, shares: 0, profile_visits: 0 },
    { campaign_type: 'conversion', spend: 3, likes: 0, comments: 0, shares: 0, profile_visits: 0 },
  ];
  const eng = { video_view: { likes: 150, comments: 3, shares: 3, profile_visits: 50 } };
  const out = mergeEngagement(monthly, eng);
  assert.equal(out[0].likes, 150); assert.equal(out[0].profile_visits, 50); assert.equal(out[0].spend, 5, 'other fields untouched');
  assert.equal(out[1].likes, 0, 'objective with no report data stays 0');   // conversion not in eng
  assert.deepEqual(mergeEngagement(monthly, {}), monthly);
});
