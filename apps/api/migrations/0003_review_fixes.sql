-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Fixes from the phase 2 security review (docs/reviews/0002-api.md).

-- A row that can never be inserted: a batch inserts into it only when a quota
-- would be exceeded, which aborts (and rolls back) the whole batch atomically.
CREATE TABLE quota_guard (x INTEGER NOT NULL);

-- Storage is now charged per row (ciphertext + nonce + 256 bytes); recount existing spaces.
UPDATE spaces SET bytes = (
  SELECT COALESCE(SUM(length(ciphertext) + length(nonce) + 256), 0) FROM records WHERE records.space_id = spaces.id
);
