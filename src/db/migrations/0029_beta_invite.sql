-- src/db/migrations/0029_beta_invite.sql
--
-- Beta access infrastructure: waitlist for pre-launch email capture and
-- invite codes for wave-based rollout.
--
-- invite_codes:
--   wave      – rollout wave number (1 = first, 2 = second, …)
--   max_uses  – how many accounts can be created with this code (default 1)
--   used_count – incremented on each successful signup
--   created_by – user_id of the person who generated (NULL = admin-issued)
--   note      – optional operator label (e.g. "friends-wave-1")
--
-- waitlist.status:
--   'pending'  – signed up, waiting
--   'invited'  – invite email sent (invite_code is set)
--   'joined'   – has created a Spooool account
--
-- user additions:
--   invite_code  – the invite_codes.code used at signup
--   beta_access  – 1 once a valid invite code has been redeemed; gates
--                  restricted features when BETA_ONLY env var is set

CREATE TABLE invite_codes (
  code TEXT PRIMARY KEY,
  created_by TEXT,
  wave INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (created_by) REFERENCES user(id) ON DELETE SET NULL
);

CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'invited', 'joined')),
  token TEXT UNIQUE NOT NULL,
  invite_code TEXT,
  created_at INTEGER NOT NULL,
  invited_at INTEGER,
  FOREIGN KEY (invite_code) REFERENCES invite_codes(code) ON DELETE SET NULL
);

ALTER TABLE user ADD COLUMN invite_code TEXT;
ALTER TABLE user ADD COLUMN beta_access INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status);
CREATE INDEX IF NOT EXISTS idx_waitlist_token ON waitlist(token);
CREATE INDEX IF NOT EXISTS idx_invite_codes_wave ON invite_codes(wave);
CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes(created_by)
  WHERE created_by IS NOT NULL;
