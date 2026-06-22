-- Fix creator_earnings and creator_payouts to use INTEGER ms timestamps,
-- consistent with every other table in this DB. The original migrations
-- defined these columns as TEXT; the webhook handler always wrote integer
-- values (e.g. 1719014400000), which SQLite/D1 stored as the text string
-- "1719014400000". new Date("1719014400000") is Invalid Date in V8, so
-- dates rendered as "Invalid Date" in the Payouts UI. CAST(...AS INTEGER)
-- recovers the ms epoch from those stored strings.

CREATE TABLE creator_earnings_v2 (
  id                  TEXT    PRIMARY KEY,
  user_id             TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind                TEXT    NOT NULL CHECK(kind IN ('tip', 'membership', 'gift')),
  amount_cents        INTEGER NOT NULL,
  currency            TEXT    NOT NULL DEFAULT 'usd',
  platform_fee_cents  INTEGER NOT NULL DEFAULT 0,
  polar_order_id      TEXT,
  polar_subscription_id TEXT,
  description         TEXT,
  created_at          INTEGER NOT NULL
);

INSERT INTO creator_earnings_v2
  SELECT id, user_id, kind, amount_cents, currency, platform_fee_cents,
         polar_order_id, polar_subscription_id, description,
         CAST(created_at AS INTEGER)
  FROM creator_earnings;

DROP TABLE creator_earnings;
ALTER TABLE creator_earnings_v2 RENAME TO creator_earnings;

CREATE INDEX creator_earnings_user_created
  ON creator_earnings(user_id, created_at DESC);

CREATE INDEX creator_earnings_polar_order
  ON creator_earnings(polar_order_id)
  WHERE polar_order_id IS NOT NULL;

CREATE TABLE creator_payouts_v2 (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  amount_cents    INTEGER NOT NULL,
  currency        TEXT    NOT NULL DEFAULT 'usd',
  polar_payout_id TEXT,
  status          TEXT    NOT NULL
    CHECK(status IN ('pending', 'in_transit', 'paid', 'failed'))
    DEFAULT 'pending',
  paid_at         INTEGER,
  created_at      INTEGER NOT NULL
);

INSERT INTO creator_payouts_v2
  SELECT id, user_id, amount_cents, currency, polar_payout_id, status,
         CAST(paid_at AS INTEGER),
         CAST(created_at AS INTEGER)
  FROM creator_payouts;

DROP TABLE creator_payouts;
ALTER TABLE creator_payouts_v2 RENAME TO creator_payouts;

CREATE INDEX creator_payouts_user_created
  ON creator_payouts(user_id, created_at DESC);

CREATE UNIQUE INDEX creator_payouts_polar_id
  ON creator_payouts(polar_payout_id)
  WHERE polar_payout_id IS NOT NULL;
