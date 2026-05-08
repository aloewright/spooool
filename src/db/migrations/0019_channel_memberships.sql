-- ALO-161: channel memberships (recurring tiers).
--
-- A creator defines one or more `channel_membership_tiers` (name, price,
-- monthly/yearly interval, optional description). When the platform's
-- Stripe key is configured we mirror each tier as a Stripe Product+Price
-- so Checkout has something to charge against.
--
-- A viewer's recurring purchase materializes as a row in
-- `channel_memberships`. Status mirrors Stripe's subscription status; the
-- video playback gate considers (member_user_id, channel_user_id) a member
-- when status IN ('active', 'trialing') AND current_period_end is in the
-- future. We don't enforce tier-level restrictions yet — any active member
-- can view any members-only video on the channel.
--
-- `videos.members_only` is the per-video paywall flag. Owners can toggle
-- it on at upload time or later; non-members get a 402 with a structured
-- payload telling the SPA to render the membership paywall.

CREATE TABLE IF NOT EXISTS channel_membership_tiers (
  id TEXT PRIMARY KEY,
  channel_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_membership_tiers_channel
  ON channel_membership_tiers(channel_user_id, archived_at);

CREATE TABLE IF NOT EXISTS channel_memberships (
  id TEXT PRIMARY KEY,
  member_user_id TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'incomplete'
    CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_end INTEGER,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_user_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_user_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (tier_id) REFERENCES channel_membership_tiers(id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_member
  ON channel_memberships(member_user_id, status);

CREATE INDEX IF NOT EXISTS idx_memberships_channel
  ON channel_memberships(channel_user_id, status);

CREATE INDEX IF NOT EXISTS idx_memberships_pair_active
  ON channel_memberships(member_user_id, channel_user_id, status);

ALTER TABLE videos ADD COLUMN members_only INTEGER NOT NULL DEFAULT 0;
