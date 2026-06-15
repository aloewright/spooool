-- Beta waitlist: collect interested creators before or alongside open signup.
-- source tracks where the signup came from (landing, pricing, etc.)

CREATE TABLE waitlist (
  id         TEXT PRIMARY KEY NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  source     TEXT NOT NULL DEFAULT 'landing',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_waitlist_created_at ON waitlist (created_at DESC);
