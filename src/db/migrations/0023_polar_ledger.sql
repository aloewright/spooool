-- src/db/migrations/0023_polar_ledger.sql
--
-- Polar payment ledger — append-only log of every Polar webhook event that
-- carries financial significance (orders, subscriptions, refunds, partner
-- benefit-grant payouts, disputes/chargebacks). Follows 0022 conventions:
--   * id TEXT PRIMARY KEY NOT NULL
--   * INTEGER ms timestamps (Date.now()), NOT CURRENT_TIMESTAMP
--   * FOREIGN KEY (...) REFERENCES user(id) where mappable
--   * status via TEXT NOT NULL CHECK (... IN (...))
--   * UNIQUE constraint on webhook_id — the Standard Webhooks message ID
--     used for idempotent writes (INSERT OR IGNORE)
--
-- polar_object_id: the Polar-side ID of the resource (order, subscription,
--   refund, benefit_grant, pledge, …). Together with event_type it uniquely
--   identifies the Polar resource state change.
-- amount_cents / currency: monetary value in the smallest unit (cents for USD).
--   NULL for non-monetary events (benefit_grant, some subscription state changes).
--   Refund amounts are stored as positive integers; callers negate when summing.
-- polar_customer_id: Polar's customer.id — may differ from our user.id.
-- meta_json: full Polar `data` object serialised as JSON for audit / replay.

CREATE TABLE IF NOT EXISTS polar_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  webhook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  polar_object_id TEXT,
  polar_customer_id TEXT,
  user_id TEXT,
  amount_cents INTEGER,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending','active','paid','cancelled','revoked','refunded','disputed','failed','unknown'
  )),
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_polar_ledger_webhook_id ON polar_ledger(webhook_id);
CREATE INDEX IF NOT EXISTS idx_polar_ledger_user_id ON polar_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_polar_ledger_customer ON polar_ledger(polar_customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_polar_ledger_event_type ON polar_ledger(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_polar_ledger_object ON polar_ledger(polar_object_id, event_type);
