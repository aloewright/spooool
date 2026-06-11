-- Channel products: stores Polar product + price IDs that creators link to their
-- channel. Used to create Polar checkout sessions for tips and memberships.
-- Creators create products in their Polar dashboard, then link them here.

CREATE TABLE IF NOT EXISTS channel_products (
  id             TEXT    PRIMARY KEY,
  user_id        TEXT    NOT NULL,
  polar_product_id TEXT  NOT NULL,
  polar_price_id TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('membership', 'tip')),
  name           TEXT    NOT NULL,
  description    TEXT,
  amount_cents   INTEGER,   -- null for custom-amount (PWYW) products
  currency       TEXT    NOT NULL DEFAULT 'usd',
  billing_interval TEXT,   -- 'month' | 'year' | null for one-time
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE INDEX IF NOT EXISTS channel_products_user_active
  ON channel_products (user_id, active);

-- Partial unique index: only ACTIVE links must be unique, so a creator can
-- re-link a Polar product after a previous link was deactivated (active = 0).
CREATE UNIQUE INDEX IF NOT EXISTS channel_products_polar_product
  ON channel_products (polar_product_id) WHERE active = 1;
