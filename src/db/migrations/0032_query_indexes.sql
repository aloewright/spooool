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
--   WHERE parent_comment_id = ? AND deleted_at IS NULL ORDER BY created_at ASC
--   WHERE parent_comment_id = c.id AND deleted_at IS NULL (correlated subquery)
--   The existing idx_comments_parent_id covers parent_comment_id alone, forcing a
--   post-filter for deleted_at and a separate sort on created_at. The compound
--   partial index lets SQLite seek to parent + alive rows in chronological order.
CREATE INDEX IF NOT EXISTS idx_comments_replies
  ON comments(parent_comment_id, created_at ASC)
  WHERE deleted_at IS NULL;

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
