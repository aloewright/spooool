-- ALO-164: Polar webhooks → D1 ledger.
--
-- `polar_webhook_events` is the idempotency table. Polar follows the
-- Standard Webhooks spec, so each delivery has a stable `webhook-id`
-- header — we use it as the primary key. Re-deliveries of the same id
-- become a no-op INSERT OR IGNORE.
--
-- `polar_ledger` is an append-only money ledger. One row per business
-- event (order paid, subscription invoice, refund, payout, dispute, …).
-- `amount_cents` is signed: positive for credits to us, negative for
-- refunds / chargebacks / payouts going out to partners.
CREATE TABLE IF NOT EXISTS polar_webhook_events (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS polar_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entry_kind TEXT NOT NULL,
  external_id TEXT,
  customer_id TEXT,
  subscription_id TEXT,
  order_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata_json TEXT,
  UNIQUE (webhook_id, entry_kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_polar_ledger_customer ON polar_ledger (customer_id);
CREATE INDEX IF NOT EXISTS idx_polar_ledger_subscription ON polar_ledger (subscription_id);
CREATE INDEX IF NOT EXISTS idx_polar_ledger_order ON polar_ledger (order_id);
CREATE INDEX IF NOT EXISTS idx_polar_ledger_occurred_at ON polar_ledger (occurred_at);
