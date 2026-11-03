# 0012. Accounts and sign-in

- Status: Accepted
- Date: 2026-11-03

## Context
The plan calls for passkeys with an email magic-link fallback, bearer tokens (no cookies, because the API is on another site), rate limits, Turnstile on sign-up, and a sign-up switch (`ALLOW_SIGNUPS`).

## Decision
- **Accounts are created by email.** `POST /auth/email/start` sends a single-use link (`APP_URL#signin=<token>`, 256-bit token, stored hashed, 15 minutes). The token is in the URL fragment so it never reaches GitHub Pages' logs. `POST /auth/email/verify` creates the account on first use and returns a session. Creating an account requires ticking the age/terms box (`accept_terms`), and respects `ALLOW_SIGNUPS`; a partner with a valid invite can always sign up.
- **Passkeys are added after sign-in** (`/auth/passkey/register/*`, discoverable credentials, `attestation: none`) and then used to sign in (`/auth/passkey/login/*`). Passkey-first account creation would need either an account without a verified email or a second round trip; email-first keeps one account model and gives everyone a recovery path. Challenges are single use, 5 minutes, bound to the user for registration.
- **No account enumeration:** `/auth/email/start` answers `{ok: true}` whether or not the address has an account or an email was sent.
- **Sessions:** 256-bit bearer tokens, stored as SHA-256, 90-day sliding expiry; each tied to a device row the user can see and revoke (`DELETE /devices/:id` ends its sessions). Max 10 devices.
- **Rate limits:** per IP and per address on magic links, per IP on passkey sign-in, per user on invites and pushes. Keys are salted hashes (`RATE_LIMIT_SALT`), so no IP or email address is stored for rate limiting; rows expire within a day. The Workers Rate Limiting binding is used when configured.
- **Email provider** is pluggable (`EMAIL_PROVIDER`): `log` (send nothing; default) or `resend`. Open question 3 decides the production provider (it needs a DPA).

## Consequences
- Every account has an email address the server can read (already in the threat model).
- Sign-in from a new device needs either a passkey synced by the platform or a magic link; keys still come from the recovery phrase or a device-link invite.
- Self-hosters without an email provider can't create accounts until they configure one (or use `log` in development and read tokens from tests/tools).
