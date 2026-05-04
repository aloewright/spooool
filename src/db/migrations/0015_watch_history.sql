-- ALO-145: signed-in watch history. Composite PK + UPSERT on (user, video)
-- so re-watches update watched_at in place rather than accumulating rows.
-- ON DELETE CASCADE on both FKs so account deletion (ALO-132) and video
-- hard-deletes don't leave orphan history rows.

CREATE TABLE IF NOT EXISTS watch_history (
  user_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  watched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, video_id),
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Backs the home-feed query "most recent N for this user".
CREATE INDEX IF NOT EXISTS idx_watch_history_user_recent
  ON watch_history(user_id, watched_at DESC);
