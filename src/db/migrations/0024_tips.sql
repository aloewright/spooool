-- Stripe Connect accounts: one row per creator who has started onboarding.
-- charges_enabled mirrors the Stripe account field (0 until onboarding done).
CREATE TABLE IF NOT EXISTS stripe_connect_accounts (
  user_id TEXT PRIMARY KEY,
  stripe_account_id TEXT NOT NULL UNIQUE,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  onboarded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

-- One row per completed tip payment.
CREATE TABLE IF NOT EXISTS tips (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  message TEXT,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  tipper_email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE INDEX IF NOT EXISTS idx_tips_video ON tips(video_id);
CREATE INDEX IF NOT EXISTS idx_tips_creator ON tips(creator_user_id, created_at DESC);
