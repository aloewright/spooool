-- ALO-122 (E3): WebVTT captions/subtitles per video. One row per language;
-- `is_default = 1` on at most one row per video selects the track the player
-- should enable on load. URLs point at WebVTT served from R2 (or any HTTPS
-- origin); the SPA renders <track> tags from this list.

CREATE TABLE IF NOT EXISTS video_captions (
  video_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, lang),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_captions_video ON video_captions(video_id);
