-- ALO-181: beta invite system + waitlist.
--
-- Three-table design:
--
--   * waitlist           — pre-launch email capture. Public endpoint
--                          accepts (email, name?, source?) and returns
--                          the entry's position. Each row is assigned to
--                          a wave (0 = unassigned) by an admin sweep.
--   * invite_codes       — codes with a per-code max_uses quota and an
--                          optional wave / expiry. `disabled_at` lets us
--                          retire a code without losing the redemption
--                          history that points at it.
--   * invite_redemptions — append-only audit log. One row per successful
--                          redeem; the (code_id, email) pair is unique so
--                          the same address can't double-claim quota.
--
-- The waitlist row keeps a pointer to the code minted for it
-- (invite_code_id) so a wave-rollout admin tool can re-send the link
-- without re-issuing.

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  source TEXT,
  referrer TEXT,
  wave INTEGER NOT NULL DEFAULT 0,
  invited_at INTEGER,
  invite_code_id TEXT,
  signed_up_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (invite_code_id) REFERENCES invite_codes(id),
  FOREIGN KEY (signed_up_user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_wave ON waitlist(wave, created_at);
CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at);

CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  wave INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_by_user_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_wave ON invite_codes(wave);
CREATE INDEX IF NOT EXISTS idx_invite_codes_disabled ON invite_codes(disabled_at);

CREATE TABLE IF NOT EXISTS invite_redemptions (
  id TEXT PRIMARY KEY,
  invite_code_id TEXT NOT NULL,
  email TEXT NOT NULL,
  user_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (invite_code_id) REFERENCES invite_codes(id),
  FOREIGN KEY (user_id) REFERENCES user(id),
  UNIQUE (invite_code_id, email)
);

CREATE INDEX IF NOT EXISTS idx_invite_redemptions_email ON invite_redemptions(email);
CREATE INDEX IF NOT EXISTS idx_invite_redemptions_code ON invite_redemptions(invite_code_id);
