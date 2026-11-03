-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Key rotation (ADR 0013): minimum key versions accepted for new writes.
-- key_version: space records and partner notifications must use at least this.
-- rotated_rev: the space's sync revision when it last rotated; devices refuse
--   records under an older version that arrive after this point.
-- personal_key_version: the user's own records and reminders.
ALTER TABLE spaces ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE spaces ADD COLUMN rotated_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN personal_key_version INTEGER NOT NULL DEFAULT 1;
