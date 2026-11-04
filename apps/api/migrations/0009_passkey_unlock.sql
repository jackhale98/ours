-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Passkey unlock (ADR 0015): the key ring sealed with a key only a passkey
-- can produce (WebAuthn PRF), one per passkey. The server can't open it.
-- Removing the passkey or the account removes it; so does changing keys.
CREATE TABLE key_unlocks (
  passkey_id TEXT PRIMARY KEY REFERENCES passkeys(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX key_unlocks_user ON key_unlocks(user_id);
