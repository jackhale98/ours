-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Security review 0003 fixes for notifications.
-- sender_user_id: held notifications are removed when the sender leaves or
--   deletes their account, and the quiet-hours cap is per sender (L2, L6).
-- scope: which key sealed the payload ('space' for the partner, 'user' for
--   one's own reminders) so the receiving device picks the right key (H1).
-- claimed_at/attempts: a run claims rows instead of deleting them first, so
--   a failed run is retried by a later one (M2).
ALTER TABLE reminders ADD COLUMN sender_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE reminders ADD COLUMN scope TEXT NOT NULL DEFAULT 'space' CHECK (scope IN ('space', 'user'));
ALTER TABLE reminders ADD COLUMN claimed_at INTEGER;
ALTER TABLE reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX reminders_sender ON reminders(sender_user_id);
