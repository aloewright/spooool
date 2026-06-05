-- Public status page: incidents, maintenance windows, periodic health snapshots.
--
-- incidents         — live service disruptions with a lifecycle status field.
-- incident_updates  — timestamped timeline entries posted to an incident.
-- maintenance_windows — planned work windows surfaced on the status page.
-- health_snapshots  — every-5-min persisted results of /api/health; powers
--                     the 90-day uptime percentage chart.

CREATE TABLE incidents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  impact      TEXT NOT NULL CHECK (impact IN ('none','minor','major','critical')),
  status      TEXT NOT NULL CHECK (status IN ('investigating','identified','monitoring','resolved')),
  started_at  TEXT NOT NULL,
  resolved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE incident_updates (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('investigating','identified','monitoring','resolved')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE maintenance_windows (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  scheduled_start  TEXT NOT NULL,
  scheduled_end    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE health_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  status            TEXT    NOT NULL CHECK (status IN ('ok','degraded')),
  db_status         TEXT    NOT NULL,
  db_latency_ms     INTEGER,
  cache_status      TEXT    NOT NULL,
  cache_latency_ms  INTEGER,
  storage_status    TEXT    NOT NULL,
  storage_latency_ms INTEGER,
  checked_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_incidents_status     ON incidents(status);
CREATE INDEX idx_incidents_started_at ON incidents(started_at DESC);
CREATE INDEX idx_incident_updates_inc ON incident_updates(incident_id);
CREATE INDEX idx_maintenance_start    ON maintenance_windows(scheduled_start);
CREATE INDEX idx_health_snapshots_at  ON health_snapshots(checked_at DESC);
