-- ALO-176: daily cost monitoring snapshots.
--
-- One row per UTC day. `total_usd_cents` is the estimated total spend, and
-- `breakdown_json` is a free-form bag (storage / egress / stream minutes /
-- workers requests / d1 reads, etc.) so we can evolve the cost model
-- without a schema change. `alerted_at` is set when an over-threshold
-- alert email has fired so the cron can't re-spam on retries.
--
-- Per-creator attribution is computed on-demand from videos.bytes (see
-- workers/cost-monitor.ts → getCreatorCostAttribution). We snapshot the
-- aggregate, not the per-user rows, to keep the table tiny.

CREATE TABLE cost_snapshots (
  snapshot_date     TEXT    NOT NULL PRIMARY KEY, -- YYYY-MM-DD (UTC)
  total_usd_cents   INTEGER NOT NULL,
  storage_bytes     INTEGER NOT NULL DEFAULT 0,
  active_creators   INTEGER NOT NULL DEFAULT 0,
  breakdown_json    TEXT    NOT NULL DEFAULT '{}',
  alerted_at        INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
