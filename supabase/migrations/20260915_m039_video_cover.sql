-- Add the clip cover thumbnail (TikTok oembed) to m039_video_monthly so Top Ads can render clip cards.
-- ADDITIVE. Nullable — cover fetch is best-effort and accumulates across daily syncs. Grants/RLS on
-- the table already cover the new column (column privileges follow the table grant to m039_app).
alter table m039_video_monthly add column if not exists cover_url text;
