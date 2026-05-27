-- Sub-project #4 of recorder + render pipeline. Holds per-session state
-- for the guided (Composer DO) creation mode. Auto-mode skips this table
-- and writes straight to render_jobs.
--
-- States:
--   questioning: DO is walking the user through the template's Q&A
--   rendering:   user clicked "Generate"; toolchain is running
--   completed:   render_jobs.status='completed' and video_id is set
--   failed:      either the agent or the render failed
--   abandoned:   no activity for 24h while still in 'questioning'

CREATE TABLE IF NOT EXISTS create_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('questioning','rendering','completed','failed','abandoned')),
  answers TEXT NOT NULL DEFAULT '{}',
  job_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id),
  FOREIGN KEY (job_id) REFERENCES render_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_create_sessions_user_status ON create_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_create_sessions_stuck ON create_sessions(status, updated_at);
