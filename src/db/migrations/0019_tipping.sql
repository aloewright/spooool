-- ALO-162: per-video tipping via Stripe Connect.
--
-- creator_payouts holds the per-creator Stripe Connect account that tips
-- are routed to. One row per user. charges_enabled / payouts_enabled are
-- mirrored from Stripe (account.updated webhook or the status endpoint)
-- so the worker can fail fast when a creator can't actually receive tips.
CREATE TABLE IF NOT EXISTS creator_payouts (
  user_id TEXT PRIMARY KEY,
  stripe_account_id TEXT NOT NULL UNIQUE,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  details_submitted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

-- tips records every Checkout session we create. Rows start as 'pending'
-- and flip to 'paid' on checkout.session.completed (or 'failed' on
-- async_payment_failed). supporter_user_id is nullable: tips are allowed
-- anonymously. anonymous=1 means the supporter has explicitly asked us
-- not to display their name even if they were signed in.
CREATE TABLE IF NOT EXISTS tips (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  supporter_user_id TEXT,
  supporter_email TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  anonymous INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tips_video_paid
  ON tips(video_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tips_creator
  ON tips(creator_user_id, created_at DESC);
