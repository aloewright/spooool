-- Support contact form submissions. Forwarded to support@spooool.com via email
-- and stored here for audit / de-duplication.

CREATE TABLE contact_messages (
  id         TEXT PRIMARY KEY NOT NULL,
  email      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_contact_messages_created_at ON contact_messages (created_at DESC);
