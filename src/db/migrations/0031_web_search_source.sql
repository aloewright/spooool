-- Add the 'web_search' source kind. SQLite cannot alter a CHECK constraint in
-- place, so recreate feed_sources with the extended CHECK and copy rows.
-- For web_search rows, `ref` holds JSON: {"q": string, "providers": string[]}.
-- NOTE: wrangler/D1 wraps each migration file in a transaction automatically,
-- so the DROP+RENAME is atomic without an explicit BEGIN/COMMIT (which D1's
-- migration runner rejects as a nested transaction).
CREATE TABLE feed_sources_new (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('spooool_channel','youtube_channel','youtube_playlist','youtube_search','tiktok_video','web_search')),
  ref TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feed_id) REFERENCES feeds(id)
);

INSERT INTO feed_sources_new (id, feed_id, kind, ref, label, position, added_at)
  SELECT id, feed_id, kind, ref, label, position, added_at FROM feed_sources;

DROP TABLE feed_sources;
ALTER TABLE feed_sources_new RENAME TO feed_sources;

CREATE INDEX IF NOT EXISTS idx_feed_sources_feed ON feed_sources(feed_id);
