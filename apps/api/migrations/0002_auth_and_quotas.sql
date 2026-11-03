-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Phase 2: sign-in, passkey challenges, rate limits, quotas, invite claiming.
-- New stored fields are listed in docs/THREAT_MODEL.md.

-- Magic-link tokens (hashed). The email is kept so the account can be created on verify.
CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX email_tokens_expiry ON email_tokens(expires_at);

-- WebAuthn challenges, single use, short-lived.
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  expires_at INTEGER NOT NULL
);

-- Fixed-window counters, used when no Rate Limiting binding is configured.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Last activity, for the inactive-account policy (warn at 12 months, delete at 13).
ALTER TABLE users ADD COLUMN last_active INTEGER;

-- Encrypted bytes stored per space, for the storage quota.
ALTER TABLE spaces ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;

-- The first account to fetch an invite claims it; nobody else can fetch it.
ALTER TABLE invites ADD COLUMN claimed_by TEXT;

-- Devices get a public, non-secret id the user sees in "Devices"; sessions point at them.
CREATE INDEX records_owner ON records(owner_user_id) WHERE owner_user_id IS NOT NULL;
