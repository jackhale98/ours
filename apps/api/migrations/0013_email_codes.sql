-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A six-digit code in each sign-in email, typed into the tab that asked for
-- it. Works where opening the link can't: an iPhone opens email links in
-- Safari or the mail app's own browser, each with storage of its own.
-- code_hash: keyed hash of the code (server secret + this row's token hash).
-- code_tries: wrong guesses so far; the code stops working after five.
ALTER TABLE email_tokens ADD COLUMN code_hash TEXT;
ALTER TABLE email_tokens ADD COLUMN code_tries INTEGER NOT NULL DEFAULT 0;
CREATE INDEX email_tokens_email ON email_tokens(email, created_at);
