-- Performance indexes – round 2.
--
-- Rationale for each index:
--
-- 1. idx_inbox_unseen (partial)
--    The unread-badge query (/api/users/me/inbox/unread-count) is called on
--    every page load:
--      SELECT COUNT(*) FROM subscription_inbox
--      WHERE subscriber_user_id = ? AND seen_at IS NULL
--    idx_inbox_user_added covers (subscriber_user_id, added_at DESC) but must
--    scan ALL of a user's inbox rows and filter seen_at in memory. A partial
--    index over only unseen rows removes the post-filter entirely and keeps the
--    index small as messages are marked seen.
--    Also covers: UPDATE ... SET seen_at = ... WHERE subscriber_user_id = ? AND seen_at IS NULL
CREATE INDEX IF NOT EXISTS idx_inbox_unseen
  ON subscription_inbox(subscriber_user_id, added_at DESC)
  WHERE seen_at IS NULL;

-- 2. idx_videos_active_visible
--    /api/videos public listing:
--      WHERE deleted_at IS NULL AND hidden_at IS NULL AND status = 'ready'
--      ORDER BY created_at DESC
--    The existing idx_videos_active_created covers (deleted_at, created_at DESC)
--    but hidden_at IS NULL is post-filtered across all non-deleted rows.
--    Adding hidden_at and status as leading columns lets SQLite seek directly
--    to visible, ready rows and walk created_at in reverse without a sort.
CREATE INDEX IF NOT EXISTS idx_videos_active_visible
  ON videos(deleted_at, hidden_at, status, created_at DESC);

-- 3. idx_comments_replies
--    Reply-count correlated subquery in the comment list:
--      SELECT COUNT(*) FROM comments
--      WHERE parent_comment_id = ? AND deleted_at IS NULL
--    idx_comments_parent_id is single-column; deleted_at is post-applied
--    across all children. The compound index covers both conditions in one seek.
CREATE INDEX IF NOT EXISTS idx_comments_replies
  ON comments(parent_comment_id, deleted_at);

-- 4. idx_edit_projects_user_created
--    User project history listing ordered by creation date.
--    idx_edit_projects_user_status covers (user_id, status) for status-filtered
--    lookups but not plain chronological listing. This covers ORDER BY created_at
--    DESC queries on a per-user basis.
CREATE INDEX IF NOT EXISTS idx_edit_projects_user_created
  ON edit_projects(user_id, created_at DESC);

-- 5. idx_videos_user_active
--    Channel header aggregates and storage quota both run:
--      SELECT COUNT(*) / SUM(...) FROM videos WHERE user_id = ? AND deleted_at IS NULL
--    idx_videos_user_id is single-column; this compound index allows a direct
--    (user_id, deleted_at) seek, skipping soft-deleted rows without a table scan.
--    Also improves the channel video list query.
CREATE INDEX IF NOT EXISTS idx_videos_user_active
  ON videos(user_id, deleted_at, created_at DESC);
