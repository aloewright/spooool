-- ALO-124: track when an inbox row was last included in an email digest so
-- repeat runs of the digest job don't re-send the same item. NULL means the
-- item has not yet been included in a digest. Rows that the user has already
-- viewed (seen_at IS NOT NULL) never get a digest.

ALTER TABLE subscription_inbox ADD COLUMN digest_sent_at TEXT;

CREATE INDEX IF NOT EXISTS idx_inbox_digest_pending
  ON subscription_inbox(subscriber_user_id, added_at DESC)
  WHERE seen_at IS NULL AND digest_sent_at IS NULL;
