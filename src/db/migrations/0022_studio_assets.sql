-- src/db/migrations/0022_studio_assets.sql
--
-- AI Studio (E11) + Native Editing (E10) persistence: edit projects, generated
-- assets, and the AI cost ledger. Follows the 0020/0021 conventions exactly:
--   * id TEXT PRIMARY KEY NOT NULL
--   * INTEGER ms timestamps (Date.now()), NOT CURRENT_TIMESTAMP
--   * FOREIGN KEY (...) REFERENCES <parent>(id) declared at the end of CREATE,
--     parent tables `user` (singular), `videos`, `render_jobs`, `edit_projects`
--   * status/kind/source via TEXT NOT NULL CHECK (... IN (...))
--   * CREATE INDEX IF NOT EXISTS idx_<table>_<cols> ON <table>(colA, colB)
--
-- edit_projects: a saved editing session over a source video (EDL = edit
--   decision list, JSON array of cuts/overlays). render_job_id links to the
--   render that materialised the project. source_video_id SET NULL on delete
--   so deleting the source doesn't orphan-cascade the project.
-- generated_assets: every artefact produced by a studio AI op (image_gen is
--   the first writer; video/audio/caption/clip follow). bytes mirrors
--   videos.bytes for storage accounting. stream_video_id set when an asset is
--   promoted into Cloudflare Stream.
-- ai_costs: append-only ledger of AI spend per op for per-user cost rollups.
--   est_usd is order-of-magnitude only (see costs.ts PRICE_* note).

CREATE TABLE IF NOT EXISTS edit_projects (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  source_video_id TEXT,
  title TEXT,
  edl_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('draft','rendering','completed','failed')),
  render_job_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id),
  FOREIGN KEY (source_video_id) REFERENCES videos(id) ON DELETE SET NULL,
  FOREIGN KEY (render_job_id) REFERENCES render_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_edit_projects_user_status ON edit_projects(user_id, status);
CREATE INDEX IF NOT EXISTS idx_edit_projects_status_updated ON edit_projects(status, updated_at);

CREATE TABLE IF NOT EXISTS generated_assets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','audio','caption','metadata','clip')),
  source TEXT NOT NULL CHECK (source IN ('image_gen','video_gen','audio_gen','stt_gen','text_gen','stream_clip')),
  r2_key TEXT,
  stream_video_id TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','ready','failed')),
  spec_json TEXT,
  error_message TEXT,
  project_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id),
  FOREIGN KEY (project_id) REFERENCES edit_projects(id)
);

CREATE INDEX IF NOT EXISTS idx_generated_assets_user_kind ON generated_assets(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_generated_assets_stream_video ON generated_assets(stream_video_id);

CREATE TABLE IF NOT EXISTS ai_costs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  op TEXT NOT NULL,
  route TEXT NOT NULL,
  model TEXT NOT NULL,
  units REAL NOT NULL,
  unit_kind TEXT NOT NULL CHECK (unit_kind IN ('tokens','seconds','images','characters')),
  est_usd REAL NOT NULL,
  project_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id),
  FOREIGN KEY (project_id) REFERENCES edit_projects(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_costs_user_created ON ai_costs(user_id, created_at);

-- videos provenance: flag AI-generated uploads and link a derived video back
-- to its source (re-edits, clips). Plain ALTER ADD COLUMN like 0011/0012/0013.
ALTER TABLE videos ADD COLUMN ai_generated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN source_video_id TEXT;
