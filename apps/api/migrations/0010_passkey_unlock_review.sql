-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Passkey unlock review 0006 fixes.
-- users.keys_changed_at: when this person last changed keys (rotation).
--   Only passkeys added after it can unlock (M1).
-- passkeys.aaguid: which passkey provider made it (iCloud Keychain, Google
--   Password Manager, ...), so people can tell their passkeys apart (M1).
-- sessions.passkey_id: the passkey this session signed in or last confirmed
--   with; setting up unlocking needs that passkey, confirmed recently (L2).
-- key_unlocks.space_version/personal_version: the key versions a copy
--   holds, so any device can tell it's out of date (L4). Not secret: the
--   server knows the current versions anyway.
ALTER TABLE users ADD COLUMN keys_changed_at INTEGER;
ALTER TABLE passkeys ADD COLUMN aaguid TEXT;
ALTER TABLE sessions ADD COLUMN passkey_id TEXT;
ALTER TABLE key_unlocks ADD COLUMN space_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE key_unlocks ADD COLUMN personal_version INTEGER NOT NULL DEFAULT 1;
