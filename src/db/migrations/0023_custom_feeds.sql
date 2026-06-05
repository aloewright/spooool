-- Multi-source custom video feeds (Phase 1).
-- feeds: a user-owned, optionally-public named feed.
-- feed_sources: the sources a feed aggregates. `ref` meaning depends on `kind`:
--   spooool_channel  -> user.id
--   youtube_channel  -> resolved YouTube channelId (UC...)
--   youtube_playlist -> YouTube playlistId (PL.../UU...)
--   youtube_search   -> raw search query
--   tiktok_video     -> canonical TikTok video URL
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE TABLE IF NOT EXISTS feed_sources (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('spooool_channel','youtube_channel','youtube_playlist','youtube_search','tiktok_video')),
  ref TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feed_id) REFERENCES feeds(id)
);

CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_feeds_last_viewed ON feeds(last_viewed_at);
CREATE INDEX IF NOT EXISTS idx_feed_sources_feed ON feed_sources(feed_id);
