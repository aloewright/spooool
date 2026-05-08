-- ALO-157: notifications (in-app bell + email digest of new uploads from subs).
--
-- The in-app bell reads from the existing `subscription_inbox` table (ALO-156)
-- — unread count = rows with seen_at IS NULL. No new table needed for that.
--
-- Email digest preferences live on the user row. Default is 'weekly' so
-- subscribers get a useful summary out of the box; users can opt out by
-- setting it to 'off'. `email_digest_last_sent_at` lets the cron skip users
-- whose window hasn't elapsed and acts as the cursor for "what's new since
-- last digest".

ALTER TABLE user ADD COLUMN email_digest_frequency TEXT NOT NULL DEFAULT 'weekly'
  CHECK (email_digest_frequency IN ('off', 'daily', 'weekly'));

ALTER TABLE user ADD COLUMN email_digest_last_sent_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_user_digest_freq
  ON user(email_digest_frequency)
  WHERE email_digest_frequency != 'off';
