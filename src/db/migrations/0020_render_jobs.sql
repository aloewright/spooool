-- Sub-project #1 of recorder + render pipeline. Tracks the lifecycle of a
-- single video render job triggered from /record: queued → rendering →
-- completed | failed. The composition_spec JSON column holds the user's
-- chosen scenes / layouts / title / brand props verbatim so the container
-- can re-run with the same inputs without re-deriving from D1 rows.
--
-- Cleanup of stuck jobs (`status='rendering'` past timeout) is handled by
-- the cron sweep in src/workers/render.ts. The idx_render_jobs_stuck index
-- exists to make that sweep cheap (it scans by status + updated_at).

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','rendering','completed','failed')),
  progress INTEGER NOT NULL DEFAULT 0,
  composition_spec TEXT NOT NULL,
  output_r2_key TEXT,
  video_id TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id),
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_user_status ON render_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_render_jobs_stuck ON render_jobs(status, updated_at);
