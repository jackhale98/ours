-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Initial schema. Every column here is listed in docs/THREAT_MODEL.md.
-- Content is never stored in plaintext: records.ciphertext is opaque.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE memberships (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  wrapped BLOB NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE key_backups (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wrapped BLOB NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('space', 'user')),
  owner_user_id TEXT,
  key_version INTEGER NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK ((scope = 'user') = (owner_user_id IS NOT NULL))
);
CREATE INDEX records_space_rev ON records(space_id, rev);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fire_at INTEGER NOT NULL,
  payload BLOB NOT NULL,
  sent_at INTEGER
);
CREATE INDEX reminders_due ON reminders(fire_at) WHERE sent_at IS NULL;

CREATE TABLE push_subs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE feed_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE feed_busy (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_utc INTEGER NOT NULL,
  end_utc INTEGER NOT NULL
);
CREATE INDEX feed_busy_user ON feed_busy(user_id, start_utc);
