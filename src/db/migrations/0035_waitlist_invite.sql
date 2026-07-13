-- Add invite tracking to the waitlist table.
-- invited_at: when an admin sent the invite email.
-- invite_token: opaque token appended to the signup URL so we can track
--               which signup came from which invite (not used for auth gate).

ALTER TABLE waitlist ADD COLUMN invited_at TEXT;
ALTER TABLE waitlist ADD COLUMN invite_token TEXT UNIQUE;

CREATE INDEX idx_waitlist_invite_token ON waitlist (invite_token) WHERE invite_token IS NOT NULL;
