-- ALO-125: monetization via Polar (Merchant of Record + creator partner payouts).
--
-- Polar is the payments spine. Creators link a Polar connected/partner
-- account; viewers buy channel memberships or tip videos via Polar
-- Checkout; webhook deliveries land in `polar_events` (raw audit), get
-- dispatched into the canonical `monetization_ledger`, and update derived
-- state (memberships + payouts). The ledger is append-only — every entry
-- is keyed on `polar_event_id` so retry-safe webhook delivery never
-- double-credits a creator.
--
-- Spooool's revenue share is captured per ledger row (`platform_fee_cents`)
-- so the share rate can change over time without rewriting history. Polar
-- itself executes the payout split via its partner program; the local
-- ledger is for our own bookkeeping + creator dashboards.

CREATE TABLE IF NOT EXISTS creator_polar_accounts (
  user_id TEXT PRIMARY KEY,
  polar_account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'rejected', 'disabled')),
  onboarding_url TEXT,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_creator_polar_accounts_account
  ON creator_polar_accounts(polar_account_id);

CREATE TABLE IF NOT EXISTS membership_tiers (
  id TEXT PRIMARY KEY,
  creator_user_id TEXT NOT NULL,
  polar_product_id TEXT,
  polar_price_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  interval TEXT NOT NULL DEFAULT 'month' CHECK (interval IN ('month', 'year')),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (creator_user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_membership_tiers_creator
  ON membership_tiers(creator_user_id, archived_at);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  polar_subscription_id TEXT UNIQUE,
  tier_id TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  subscriber_user_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'past_due', 'canceled', 'incomplete')),
  current_period_end INTEGER,
  canceled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tier_id) REFERENCES membership_tiers(id),
  FOREIGN KEY (creator_user_id) REFERENCES user(id),
  FOREIGN KEY (subscriber_user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_subscriber
  ON memberships(subscriber_user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_creator
  ON memberships(creator_user_id, status);

CREATE TABLE IF NOT EXISTS polar_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  process_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_polar_events_type
  ON polar_events(event_type, received_at DESC);

CREATE TABLE IF NOT EXISTS monetization_ledger (
  id TEXT PRIMARY KEY,
  polar_event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL
    CHECK (kind IN ('tip', 'membership_payment', 'refund', 'payout', 'adjustment')),
  creator_user_id TEXT NOT NULL,
  payer_user_id TEXT,
  video_id TEXT,
  membership_id TEXT,
  gross_amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  net_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  occurred_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (creator_user_id) REFERENCES user(id),
  FOREIGN KEY (video_id) REFERENCES videos(id),
  FOREIGN KEY (membership_id) REFERENCES memberships(id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_creator
  ON monetization_ledger(creator_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_video
  ON monetization_ledger(video_id);
CREATE INDEX IF NOT EXISTS idx_ledger_membership
  ON monetization_ledger(membership_id);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  polar_payout_id TEXT NOT NULL UNIQUE,
  creator_user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'paid', 'failed', 'canceled')),
  arrival_date INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (creator_user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS idx_payouts_creator
  ON payouts(creator_user_id, created_at DESC);
