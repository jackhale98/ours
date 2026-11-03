-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Phase 5: notifications.
--
-- Reminders and quiet-hours-deferred notifications share one queue. The
-- server knows only who it is for, when to send it, and the key version; the
-- record it belongs to is inside the ciphertext (the old record_id column is
-- gone). The table was never written to before this migration.
DROP TABLE reminders;
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'reminder' (set by the target for themselves) or 'deferred' (held for quiet hours)
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'deferred')),
  fire_at INTEGER NOT NULL,
  key_version INTEGER NOT NULL,
  payload BLOB NOT NULL, -- nonce || ciphertext, sealed with the space key
  created_at INTEGER NOT NULL
);
CREATE INDEX reminders_due ON reminders(fire_at);
CREATE INDEX reminders_target ON reminders(target_user_id, space_id, kind);

-- Quiet hours: minutes after local midnight, and the IANA zone to read them in.
ALTER TABLE users ADD COLUMN quiet_start INTEGER;
ALTER TABLE users ADD COLUMN quiet_end INTEGER;
ALTER TABLE users ADD COLUMN quiet_tz TEXT;
