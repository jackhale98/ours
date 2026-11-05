-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A six-digit code in each sign-in email, typed into the tab that asked for
-- it. Works where opening the link can't: an iPhone opens email links in
-- Safari or the mail app's own browser, each with storage of its own.
-- code_hash: HMAC-SHA256 of the code, keyed by the server secret, over this
--   row's token hash and the code.
-- code_tries: wrong guesses so far; the code stops working after five.
ALTER TABLE email_tokens ADD COLUMN code_hash TEXT;
ALTER TABLE email_tokens ADD COLUMN code_tries INTEGER NOT NULL DEFAULT 0;
CREATE INDEX email_tokens_email ON email_tokens(email, created_at);

-- Wrong codes per address since its last successful email sign-in (link or
-- code):
-- past 100, emails carry a link only, so guessing can never add up to a
-- likely takeover. key: salted hash of the address, as for rate limits.
CREATE TABLE code_failures (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
