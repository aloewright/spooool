-- Track when a waitlist entry was invited so admins can see who has and
-- hasn't been reached out to yet.
ALTER TABLE waitlist ADD COLUMN invited_at TEXT;
CREATE INDEX idx_waitlist_invited_at ON waitlist (invited_at);
