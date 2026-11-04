-- SPDX-License-Identifier: AGPL-3.0-or-later
-- passkeys.prf: whether the passkey's app said, when it was added, that it
--   can give an unlock secret (the WebAuthn PRF extension): 1 yes, 0 no,
--   NULL not said. Only used to show which passkeys can unlock keys; not a
--   secret, and not relied on for anything else.
ALTER TABLE passkeys ADD COLUMN prf INTEGER;
