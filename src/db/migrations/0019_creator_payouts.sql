-- ALO-163: creator payouts ledger.
--
-- The Polar API is the source of truth for creator balances and payout
-- history, but every revenue-bearing event (tip, subscription, ad share)
-- also lands in this local D1 ledger so the dashboard can render an
-- earnings + pending + recent-transactions view without paying a Polar
-- round-trip on every page load. Ledger rows are immutable; corrections
-- are recorded as additional rows with a negative `amount_cents`.
--
-- amount_cents:    integer cents in the user's payout currency.
-- currency:        ISO 4217 (defaults to USD; per-row so a creator can
--                  earn in mixed currencies without a schema change).
-- kind:            event source, e.g. 'tip' | 'subscription' | 'ad_share'
--                  | 'payout' | 'adjustment'. 'payout' rows are negative
--                  (money leaving the balance toward the creator's bank).
-- status:          'pending' | 'available' | 'paid' | 'reversed'.
-- external_id:     Polar transaction id (NULL for rows synthesised
--                  locally before Polar acknowledges them).

CREATE TABLE IF NOT EXISTS creator_ledger (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  amount_cents  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  description   TEXT,
  external_id   TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_creator_ledger_user_created
  ON creator_ledger(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creator_ledger_user_status
  ON creator_ledger(user_id, status);
