# Threat model

## Assets

1. **Content**: event titles, times, places, notes, lists and items, comments, check-ins, display names and colours, settings.
2. **Keys**: space keys, personal keys, recovery phrase, invite secrets.
3. **Metadata**: everything the server must see to sync and notify (below).

## Adversaries and what we promise

| Adversary | Content | Notes |
|---|---|---|
| Someone with a copy of the database (leak, backup, subpoena) | **Protected** | Only ciphertext, nonces and metadata are stored. |
| A curious or compromised server operator | **Protected** | The server never receives keys or plaintext. It can drop, delay, reorder or replay ciphertext; see "integrity" below. |
| Bugs in server code | **Protected** | Same as above; scope checks are enforced in SQL as defence in depth for metadata. |
| Network attacker | **Protected** | TLS plus end-to-end encryption. |
| Your partner | Your **private** records (scope `user`) are protected; shared records are, by design, readable. |
| Someone with your unlocked device | **Not protected** | |
| Malicious frontend code (repo or Pages compromise) | **Not protected** | Mitigated by open source, protected `main`, pinned CI actions, published build hashes. |

## Integrity against the server

- **Swapping ciphertexts** between records, spaces, scopes, owners or key versions fails authentication (AAD binding).
- **Cross-purpose substitution** (an invite blob served as a backup, a record as a notification) fails: every purpose uses its own HKDF label and AAD label.
- **Replaying an old version** of a record: the device keeps the version with the newer authenticated timestamp and re-pushes it.
- **Replaying a notification** older than 24 hours: dropped by the receiving service worker. Within 24 hours a replay can re-show a notification.
- **Tampered invite**: cannot be forged without the secret in the link. A link replaced in transit (e.g. an attacker's own invite) is caught by comparing safety codes in person.
- **Rollback of the key backup** to an older version: possible (the server picks which backup to serve). The effect is losing newer key versions on a restored device, not disclosure. The client should warn if the restored backup version is lower than one it has seen.
- **Withholding data** (not syncing, deleting): possible; the server is trusted for availability, not secrecy.

## Metadata the server can see

Every stored field (keep in sync with `apps/api/migrations` and the privacy policy):

| Table | Fields | Why |
|---|---|---|
| users | id, email, created_at | Sign-in, magic links |
| passkeys | id, user_id, public_key, counter, transports, created_at | Passkey sign-in |
| sessions | token_hash, user_id, device_id, created_at, expires_at, last_seen | Authentication; raw tokens never stored |
| devices | id, user_id, label, created_at, last_seen | Device list and revocation (label is user-chosen; keep it generic) |
| spaces | id, created_at, seq | Sync ordering |
| memberships | space_id, user_id, role, joined_at | Who shares which space |
| invites | id, space_id, kind, wrapped (ciphertext), created_by, expires_at, used_at | Pairing and device linking |
| key_backups | user_id, wrapped (ciphertext), version, updated_at | Recovery |
| records | id, space_id, scope, owner_user_id, key_version, nonce, ciphertext, deleted, rev, updated_at, updated_by | Sync. Reveals record count, padded size (64-byte buckets), change times, who changed it, whether it is private, deletion |
| reminders | id, space_id, record_id, target_user_id, fire_at, payload (ciphertext), sent_at | Reveals **when** reminders fire |
| push_subs | id, user_id, device_id, endpoint, p256dh, auth, created_at, last_ok, failures | Web Push delivery |
| feed_tokens | token_hash, user_id, created_at, revoked_at | Calendar feed |
| feed_busy | user_id, start_utc, end_utc | **Plaintext** busy blocks, only if the user opts in to the calendar feed |

Also visible transiently, not stored in D1: IP addresses and user agents (Cloudflare edge), request timing, push timing. Worker logs contain route, method, status and latency only — never bodies or tokens.

Third parties: Cloudflare (hosting, D1), the email provider (email address and magic-link timing), browser push services (encrypted payloads, timing).

## Cryptographic choices

See ADR 0003. Summary: XChaCha20-Poly1305 (random nonces), HKDF-SHA256 with per-purpose labels, BIP39 English wordlist for 128-bit recovery entropy, SHA-256 safety codes. All from audited `@noble`/`@scure` libraries; no custom primitives.

## Known limitations and follow-ups

- Key rotation on device removal is phase 7. Until then, a removed device that kept the space key can still decrypt anything it can obtain from the server, so removal also revokes its sessions.
- Ciphertext size buckets are 64 bytes; very long notes are distinguishable from short ones.
- The safety code is 9 digits (~30 bits). It is meant for an in-person comparison, not as protection against an attacker able to grind 2^30 invites per pairing attempt *and* replace the link.
