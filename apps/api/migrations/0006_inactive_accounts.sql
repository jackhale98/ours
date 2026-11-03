-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Phase 7: inactive-account policy (warn at 12 months, delete a month later).
ALTER TABLE users ADD COLUMN inactive_warned_at INTEGER;
CREATE INDEX users_last_active ON users(last_active);
