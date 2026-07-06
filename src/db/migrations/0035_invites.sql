-- Beta invite system: admins send time-limited invite tokens to waitlist entries.
-- accepted_at is NULL until the invited user creates an account.

CREATE TABLE invites (
  id          TEXT PRIMARY KEY NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  name        TEXT,
  sent_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  accepted_at TEXT,
  expires_at  TEXT NOT NULL
);

CREATE INDEX idx_invites_token ON invites (token);
CREATE INDEX idx_invites_email ON invites (email);
