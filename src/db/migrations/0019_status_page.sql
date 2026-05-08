-- ALO-182: public status page tables.
--
-- `incidents` is the operator-curated registry of past + ongoing service
-- incidents shown on status.spooool.com. Each row moves through
-- investigating -> identified -> monitoring -> resolved; updates accumulate
-- in `incident_updates` so the public page can render the timeline.
--
-- `maintenance_windows` is the planned-maintenance calendar — a simple
-- start/end + summary that surfaces on the same page. Windows whose
-- `ends_at` is in the past are treated as historical.
--
-- The current health snapshot itself is computed live from /api/health
-- (db, cache, storage probes). Persisting probe samples is intentionally
-- deferred — the existing real-time check is enough to render an
-- "operational | degraded" status.

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  -- Short human-readable component label (e.g. "API", "Video playback").
  component TEXT NOT NULL DEFAULT 'platform',
  status TEXT NOT NULL DEFAULT 'investigating'
    CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  -- Public-facing severity. minor = degraded behavior; major = partial
  -- outage; critical = full outage.
  severity TEXT NOT NULL DEFAULT 'minor'
    CHECK (severity IN ('minor', 'major', 'critical')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS idx_incidents_status_started
  ON incidents(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_started
  ON incidents(started_at DESC);

CREATE TABLE IF NOT EXISTS incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  message TEXT NOT NULL,
  posted_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  FOREIGN KEY (posted_by_user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS idx_incident_updates_incident
  ON incident_updates(incident_id, created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- ISO-8601 timestamps for window start/end. Stored as TEXT so D1's
  -- date functions and the JS Date parser both round-trip.
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_starts ON maintenance_windows(starts_at DESC);
