-- Per-objective awareness enrichment for m039_ads_monthly.
-- video_6s / video_15s / video_completed come from the processed /ad-accounts/metrics feed (already
-- per objective). likes / comments / shares / profile_visits are the COMPLETE per-objective split,
-- summed from TikTok's raw integrated report (report/integrated/get/) via the gateway — the processed
-- feed only exposes a combined `engagement`. All default 0 so existing rows and any failed report
-- run read as 0, never null. Table-level grants to m039_app already cover new columns.
alter table m039_ads_monthly
  add column if not exists video_6s        bigint not null default 0,
  add column if not exists video_15s       bigint not null default 0,
  add column if not exists video_completed bigint not null default 0,
  add column if not exists likes           bigint not null default 0,
  add column if not exists comments        bigint not null default 0,
  add column if not exists shares          bigint not null default 0,
  add column if not exists profile_visits  bigint not null default 0;
