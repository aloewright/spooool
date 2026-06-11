-- Query-level index additions to cover hot-path patterns identified by
-- cross-referencing EXPLAIN QUERY PLAN against the workers query files.
--
-- idx_videos_browse — /api/videos browse listing
--   WHERE deleted_at IS NULL AND hidden_at IS NULL ORDER BY created_at DESC
--   The existing idx_videos_active_created covers (deleted_at, created_at DESC)
--   but must re-check hidden_at for every row in the deleted_at slice. A partial
--   index that pre-filters both null columns is smaller and eliminates that
--   post-filter entirely, letting SQLite walk created_at in order directly.
CREATE INDEX IF NOT EXISTS idx_videos_browse
  ON videos(created_at DESC)
  WHERE deleted_at IS NULL AND hidden_at IS NULL;

-- idx_comments_replies — reply fetch + reply_count correlated subquery in comments.ts
--   WHERE parent_comment_id IN (...) AND deleted_at IS NULL ORDER BY created_at ASC
--   WHERE parent_comment_id = c.id AND deleted_at IS NULL (correlated subquery)
--   The existing idx_comments_parent_id covers parent_comment_id alone, forcing a
--   post-filter for deleted_at. A compound index with deleted_at as the second key
--   gives the planner two seek constraints, so it wins over idx_comments_parent_id
--   for IN-list fetches too (a partial index loses that contest without ANALYZE).
CREATE INDEX IF NOT EXISTS idx_comments_replies
  ON comments(parent_comment_id, deleted_at, created_at ASC);

-- idx_generated_assets_user_kind_status — studio asset lookup in studio.ts
--   WHERE user_id = ? AND kind = 'image' AND status = 'ready'
--   The existing idx_generated_assets_user_kind covers (user_id, kind) but needs a
--   post-filter for status. Adding status as the third column avoids that scan.
CREATE INDEX IF NOT EXISTS idx_generated_assets_user_kind_status
  ON generated_assets(user_id, kind, status);

-- idx_inbox_unseen — unread-count query in subscriptions.ts
--   WHERE subscriber_user_id = ? AND seen_at IS NULL
--   The existing idx_inbox_user_added covers (subscriber_user_id, added_at DESC)
--   for the feed listing but must scan all user rows to count only unseen ones.
--   The partial index stores only unseen rows, shrinking the scan dramatically as
--   the inbox grows (most items become seen over time).
CREATE INDEX IF NOT EXISTS idx_inbox_unseen
  ON subscription_inbox(subscriber_user_id, added_at DESC)
  WHERE seen_at IS NULL;

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
