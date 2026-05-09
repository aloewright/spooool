-- ALO-122 (E3): per-video caption / subtitle tracks. Multiple tracks per
-- video so a single upload can ship English + translations. `is_default`
-- flags the track the player auto-enables when captions are turned on.
-- VTT bodies live in R2 under `${user_id}/${video_id}/captions/${language}.vtt`;
-- this table just holds the metadata + the R2 key so the worker can resolve
-- the object on demand.
--
-- ON DELETE CASCADE on the video FK so video hard-deletes don't orphan rows.

CREATE TABLE IF NOT EXISTS video_captions (
  video_id TEXT NOT NULL,
  language TEXT NOT NULL,
  label TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, language),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_captions_video ON video_captions(video_id);
