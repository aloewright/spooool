-- ALO-160: Polar partner onboarding columns on the user row.
--
-- Each spooool creator who wants to monetize gets a Polar Organization
-- ("partner") created on their behalf. Polar's organization id is a UUID
-- that lives forever once issued, so we persist it locally rather than
-- re-resolving via email lookup. The `status` column mirrors Polar's
-- enum (`created` -> `review` -> `active`, plus terminal/blocked states)
-- so the UI can decide when the creator needs to be re-prompted to
-- finish onboarding without round-tripping the Polar API on every page
-- load. `payouts_enabled` is the gate the upload / monetization flows
-- actually check; it is updated from Polar's `capabilities.payouts`.
--
-- Re-onboarding rule: any status other than 'active' OR payouts_enabled=0
-- means the partner still has outstanding KYC / payout requirements and
-- should be sent back through the onboarding flow. See
-- src/workers/polar.ts -> needsReonboarding for the canonical predicate.
--
-- All columns nullable / 0-default so existing rows are unaffected.

ALTER TABLE user ADD COLUMN polar_organization_id TEXT;
ALTER TABLE user ADD COLUMN polar_organization_status TEXT;
ALTER TABLE user ADD COLUMN polar_payouts_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user ADD COLUMN polar_onboarding_started_at INTEGER;
ALTER TABLE user ADD COLUMN polar_synced_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_polar_organization_id
  ON user(polar_organization_id)
  WHERE polar_organization_id IS NOT NULL;
