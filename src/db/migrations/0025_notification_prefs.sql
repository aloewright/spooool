-- ALO-???  Notification preferences per user.
-- Both default ON so existing users keep receiving notifications
-- unless they opt out.  Stored as INTEGER 0/1 (SQLite has no BOOLEAN type).

ALTER TABLE user ADD COLUMN notify_email_new_upload INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user ADD COLUMN notify_email_comments   INTEGER NOT NULL DEFAULT 1;
