-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Review 0007 cleanup.
-- email_tokens.invite_hash: the invite (hashed id) presented when the sign-in
--   link was asked for. Opening the link uses it, so a device needn't send an
--   invite kept for someone else's address (I11).
ALTER TABLE email_tokens ADD COLUMN invite_hash TEXT;
