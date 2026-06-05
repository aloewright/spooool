-- ALO-XXX: creator payout ledger.
--
-- creator_earnings: one row per revenue event attributed to a creator (tip,
-- membership payment, gift). Written by the Polar webhook handler when a
-- payment is confirmed. platform_fee_cents is the 10 % platform cut already
-- deducted — net to creator = amount_cents - platform_fee_cents.
--
-- creator_payouts: one row per Polar payout disbursement. Status tracks the
-- Polar payout lifecycle (pending → in_transit → paid | failed). Synced from
-- Polar webhook events or the periodic reconciliation sweep.
--
-- polar_account_id on user: the Polar account ID that receives this creator's
-- share of earnings. Set when the creator completes Polar onboarding.

ALTER TABLE user ADD COLUMN polar_account_id TEXT;

CREATE TABLE IF NOT EXISTS creator_earnings (
  id                  TEXT    PRIMARY KEY,
  user_id             TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind                TEXT    NOT NULL CHECK(kind IN ('tip', 'membership', 'gift')),
  amount_cents        INTEGER NOT NULL,
  currency            TEXT    NOT NULL DEFAULT 'usd',
  platform_fee_cents  INTEGER NOT NULL DEFAULT 0,
  polar_order_id      TEXT,
  polar_subscription_id TEXT,
  description         TEXT,
  created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX creator_earnings_user_created ON creator_earnings(user_id, created_at DESC);
CREATE INDEX creator_earnings_polar_order  ON creator_earnings(polar_order_id)
  WHERE polar_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS creator_payouts (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  amount_cents    INTEGER NOT NULL,
  currency        TEXT    NOT NULL DEFAULT 'usd',
  polar_payout_id TEXT,
  status          TEXT    NOT NULL
    CHECK(status IN ('pending', 'in_transit', 'paid', 'failed'))
    DEFAULT 'pending',
  paid_at         TEXT,
  created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX creator_payouts_user_created ON creator_payouts(user_id, created_at DESC);
CREATE UNIQUE INDEX creator_payouts_polar_id ON creator_payouts(polar_payout_id)
  WHERE polar_payout_id IS NOT NULL;
