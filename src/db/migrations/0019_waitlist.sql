-- ALO-127: public waitlist for pre-launch beta invites.
--
-- One row per email. We sync to Resend audience asynchronously (best-effort)
-- so that signups are recorded even if RESEND_API_KEY is unset or the API is
-- down. `invited_at` flips when an admin (or a launch script) issues an
-- invite so we can target follow-up emails to "still on the list".

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'web',
  referrer TEXT,
  created_at INTEGER NOT NULL,
  invited_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at);
CREATE INDEX IF NOT EXISTS idx_waitlist_invited_at ON waitlist(invited_at) WHERE invited_at IS NOT NULL;
