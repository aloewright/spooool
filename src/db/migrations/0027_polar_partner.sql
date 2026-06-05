-- src/db/migrations/0027_polar_partner.sql
--
-- Polar partner onboarding: links a Spooool creator to their Polar organization
-- so tips and memberships can be routed to their payout account.
--
-- polar_organization_id: the Polar organization ID returned by GET /v1/organizations
--   after the creator completes the OAuth connect flow. NULL until connected.
--
-- polar_account_status: tracks payout-account readiness.
--   'not_connected' – creator has not started Polar onboarding (default)
--   'pending'       – OAuth done; payout account not yet set up or pending verification
--   'active'        – payout account connected, verified, and ready
--   'under_review'  – Polar / Stripe has flagged the account for additional KYC review

ALTER TABLE user ADD COLUMN polar_organization_id TEXT;
ALTER TABLE user ADD COLUMN polar_account_status TEXT NOT NULL DEFAULT 'not_connected'
  CHECK (polar_account_status IN ('not_connected', 'pending', 'active', 'under_review'));

CREATE INDEX IF NOT EXISTS idx_user_polar_organization ON user(polar_organization_id)
  WHERE polar_organization_id IS NOT NULL;
