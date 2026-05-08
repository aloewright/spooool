-- ALO-132: per-user notification preferences for the account settings page.
--
-- `notify_product_emails` controls transactional product update emails;
-- `notify_marketing_emails` controls bulk/marketing email and is mirrored
-- to the Resend audience `unsubscribed` flag at write time so unsub
-- preference is honored without depending on the Resend list as the source
-- of truth. Both default to opt-in (1) to match the signup flow.

ALTER TABLE user ADD COLUMN notify_product_emails INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user ADD COLUMN notify_marketing_emails INTEGER NOT NULL DEFAULT 1;
