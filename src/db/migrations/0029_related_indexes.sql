-- E9 performance: cover the related-video queries in related.ts
--
-- Pass 1 (same-channel): WHERE user_id = ? AND status = 'ready'
--   AND deleted_at IS NULL AND hidden_at IS NULL ORDER BY created_at DESC
-- The existing idx_videos_user_id covers the equality scan but SQLite still
-- needs to re-filter status/deleted_at/hidden_at for every row. A compound
-- index lets it seek directly to ready, non-deleted, non-hidden rows for
-- that user and walk created_at in order without a post-sort.
CREATE INDEX IF NOT EXISTS idx_videos_channel_ready
  ON videos(user_id, status, deleted_at, hidden_at, created_at DESC);

-- Pass 3 (global fill-up): WHERE status = 'ready' AND deleted_at IS NULL
--   AND hidden_at IS NULL ORDER BY view_count DESC, created_at DESC
-- No existing index covers (status, deleted_at) together; this global scan
-- is also hit by the /api/videos listing and the fill-up step of trending.
CREATE INDEX IF NOT EXISTS idx_videos_ready_popular
  ON videos(status, deleted_at, hidden_at, view_count DESC, created_at DESC);
