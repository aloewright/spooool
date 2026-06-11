-- Performance indexes for frequently-filtered queries (ALO-perf-2)
--
-- idx_comments_top_level: covers the top-level comment listing query in comments.ts.
--   WHERE video_id = ? AND parent_comment_id IS NULL AND deleted_at IS NULL
--   ORDER BY created_at DESC LIMIT ? OFFSET ?
--   The existing idx_comments_video_created is (video_id, created_at DESC) and does not
--   include parent_comment_id, so SQLite re-filters parent_comment_id IS NULL on every
--   row returned by that index. Adding parent_comment_id as the second column lets the
--   planner seek directly to top-level (NULL) rows and walk created_at in order.
CREATE INDEX IF NOT EXISTS idx_comments_top_level
  ON comments(video_id, parent_comment_id, deleted_at, created_at DESC);

-- idx_comments_replies: covers the reply fetch in comments.ts.
--   WHERE parent_comment_id IN (...) AND deleted_at IS NULL ORDER BY created_at ASC
--   The existing idx_comments_parent_id is (parent_comment_id) only; adding deleted_at
--   avoids a post-filter pass and the (created_at ASC) suffix avoids a filesort for
--   each parent bucket.
CREATE INDEX IF NOT EXISTS idx_comments_replies
  ON comments(parent_comment_id, deleted_at, created_at ASC);

-- idx_videos_user_feed: covers spoooolChannelItems in feeds.ts.
--   WHERE user_id = ? AND deleted_at IS NULL AND hidden_at IS NULL
--     AND dmca_status IS NULL ORDER BY created_at DESC LIMIT ?
--   The existing idx_videos_channel_ready is (user_id, status, deleted_at, hidden_at,
--   created_at DESC). The feed query does NOT filter on status, so after the user_id
--   equality seek SQLite must scan rows for every status and re-filter. This index
--   skips status entirely and lets the planner seek directly to visible rows and walk
--   created_at without a post-sort.
CREATE INDEX IF NOT EXISTS idx_videos_user_feed
  ON videos(user_id, deleted_at, hidden_at, dmca_status, created_at DESC);
