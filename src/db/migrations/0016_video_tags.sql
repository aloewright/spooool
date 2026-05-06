-- ALO-151: tag/category browse.
--
-- Tags are a separate table keyed by slug so we can store the human-friendly
-- label once and reuse it across videos. video_tags is a plain join table —
-- a video can carry multiple tags, and the same tag can apply to many videos.
-- ON DELETE CASCADE keeps the join clean when either side goes away.

CREATE TABLE IF NOT EXISTS tags (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id TEXT NOT NULL,
  tag_slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, tag_slug),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_slug) REFERENCES tags(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_slug);
CREATE INDEX IF NOT EXISTS idx_video_tags_video ON video_tags(video_id);
