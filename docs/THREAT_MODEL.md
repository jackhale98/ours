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
- **Flipping a tombstone**: the `deleted` flag is bound into the AAD and must match the encrypted record, so the server cannot delete or resurrect a record on devices.
- **Replaying a notification**: each payload carries a random id and an authenticated `not_before`/`expires_at` window (max 7 days, 5 min clock skew). The service worker drops early, expired and already-shown payloads.
- **Private content under the shared key**: `sealDecodedRecord` refuses to seal busy-only events and private lists under the space key, and receivers flag such records.
- **Tampered invite**: cannot be forged without the secret in the link. A link replaced in transit (e.g. an attacker's own invite) is caught by comparing safety codes in person.
- **Leaked invite link**: the link secret plus the stored blob *is* the space key (or, for device links, the whole key ring). "Single use" is enforced by the server, not by cryptography, and the safety code does not detect an eavesdropper who saw the link. The first account to fetch an invite claims it, so nobody else can fetch the blob; the blob is erased when the invite is accepted; unaccepted invites expire after 24 h (and are deleted by the hourly cleanup); invite ids are stored hashed; and the app strips the fragment from history. Moving to an ephemeral key exchange is tracked in `docs/reviews/0001-core-crypto.md` (M4).
- **Rollback of the key backup** to an older version: possible (the server picks which backup to serve). The effect is losing newer key versions on a restored device, not disclosure. Devices merge the current backup into their ring before writing a new one (`KeyRing.mergeFrom`), so a stale ring never overwrites keys; key versions can never be silently replaced.
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
| key_unlocks | passkey_id, user_id, wrapped (ciphertext), created_at | Passkey unlock (ADR 0015), only if turned on: which passkeys can unlock, and the key ring sealed with a key only that passkey can produce |
| records | id, space_id, scope, owner_user_id, key_version, nonce, ciphertext, deleted, rev, updated_at, updated_by | Sync. Reveals record count, padded size (64-byte buckets), change times, who changed it, whether it is private, deletion |
| reminders | id, space_id, target_user_id, kind (`reminder` or `deferred`), fire_at, key_version, payload (ciphertext), created_at | Reminders a user set for themselves (up to 64, at most 8 days ahead) and partner notifications held for quiet hours. Reveals **when** reminders fire, not which plan; deleted when sent |
| push_subs | id, user_id, device_id, endpoint, p256dh, auth, created_at, last_ok, failures | Web Push delivery, one per device; dropped when the push service says it is gone |
| users (added) | quiet_start, quiet_end, quiet_tz | Quiet hours, only if set: reveals the user's time zone |
| feed_tokens | token_hash, user_id, created_at, revoked_at | Calendar feed |
| feed_busy | user_id, start_utc, end_utc | **Plaintext** busy blocks, only if the user opts in to the calendar feed. They can include the partner's busy times only while the partner is in the space and has agreed (`feed_share_busy`, a shared setting) |
| users (added) | last_active, inactive_warned_at | Inactive-account policy (warn at 12 months, delete a month later) |
| spaces (added) | bytes | Storage quota (total ciphertext size per space) |
| invites (added) | claimed_by | The first account to fetch an invite claims it; blob erased on accept |
| email_tokens | token_hash, email, created_at, expires_at, used_at | Magic links; deleted a day after expiry |
| auth_challenges | id, user_id, challenge, purpose, expires_at | Passkey ceremonies; single use, 5 minutes |
| rate_limits | key (salted hash, no IP or email), window_start, count | Abuse protection; deleted after a day |

**Imported calendars (opt-in):** when a user adds a calendar by subscription link, each refresh is relayed by the Worker, which sees the subscription URL and that calendar's contents **in transit** (not stored, not logged). The URL itself is stored only inside an encrypted record. File imports never reach the server. See ADR 0011.

**Notifications (ADR 0010):** the sender's device seals the text with the space key (`sealNotification`, with an authenticated time window and replay id). The Worker wraps that ciphertext in Web Push encryption (RFC 8291) for each of the recipient's subscriptions and signs with its VAPID key. The push service sees neither layer's content; the Worker never sees the text. The recipient's service worker opens it with the key ring on that device and drops replays and stale messages. The server learns who notified whom and when, and when reminders fire. The push endpoint allowlist stops the Worker being used to send requests anywhere else.

Notification metadata the server and push services can observe (security review 0003, L5): who notifies whom and when; reminder fire times, which with common lead times (15 minutes, 1 hour, 1 day, or 9 AM for all-day plans) hint at when plans start, including private ones; the time zone if quiet hours are set; payload sizes rounded up to 64 bytes; and the `Urgency` header, which is `high` for reminders and `normal` for partner notifications. Reminders are sealed with the person's own key, never the shared space key, and every notification's authenticated data names its recipient, so the server cannot show one person's reminder or message on the other's device.

The service worker precaches only the static build (HTML, JS, CSS, fonts, icons). It never caches API responses; user data lives only in the encrypted IndexedDB store.

Cloudflare's own invocation logs are switched off (`observability.logs.invocation_logs: false`, enforced by `pnpm check:worker`), because they would record request URLs and client IP addresses.

Also visible transiently, not stored in D1: IP addresses and user agents (Cloudflare edge), request timing, push timing. Worker logs contain route, method, status and latency only — never bodies or tokens.

Third parties: Cloudflare (hosting, D1), the email provider (email address and magic-link timing), browser push services (encrypted payloads, timing).

## Cryptographic choices

See ADR 0003. Summary: XChaCha20-Poly1305 (random nonces), HKDF-SHA256 with per-purpose labels, BIP39 English wordlist for 128-bit recovery entropy, SHA-256 safety codes. All from audited `@noble`/`@scure` libraries; no custom primitives.

## Known limitations and follow-ups

- Imported-calendar refreshes go through the server in plaintext (ADR 0011). Users who need full end-to-end protection for those calendars should use file import instead.
- Partners cannot cryptographically prove authorship to each other (`author`, `device_id` are under the shared key). The server cannot forge them.
- Key rotation (ADR 0013, review 0005): after removing a device, "Secure your space" makes new space and personal keys, saves a new recovery backup over them, and only then makes them current; every live record is re-encrypted until the server reports none left under old keys, and old versions become decrypt-only (the server refuses writes, notifications and reminders under any version but the current one; reminders and held notifications under old keys are deleted). The partner gets the new space key through a key update link that only the rotating member can make, for 14 days, and compares the new safety code before using it; other own devices are re-linked. Residual risks:
  - A removed device can still read what it already had, and anything under old keys in D1 Time Travel until that expires (30 days).
  - A removed device that can still sign in (a passkey saved on it, or the email account open on it) can rotate again itself, which locks the real devices out until they rotate back (denial of service), and could send the partner a key update link of its own. The link only works if the partner skips comparing the safety code in person; both members are emailed whenever keys change. "Secure your space" says to remove that passkey and secure the email first.
  - A malicious server can withhold key updates (denial of service) and cannot read the new keys. The key fingerprints it stores and returns come from the server, so they protect against honest mistakes (a failed rotation, a removed device's own keys), not against the server itself: a server working with someone who holds old keys can report any fingerprint, or none. Against that, comparing the safety code is the check that doesn't depend on the server; it is asked for before any link changes the shared key, from the partner or from one of your own devices. A key that a link replaces is kept aside on the device, never deleted. Devices never accept a lower floor than they've seen, pin the rotation point the first time they learn it, and refuse key-version downgrades of records they hold; a device that first learns of a rotation from a lying server (e.g. a new one) can't check the rotation point it's given.
  - Backdating: someone holding an old key, working with the server, can still add records under the old key with a revision at or below the rotation point, and devices accept them as written before the rotation. Personal records use the space's rotation point.
  - A record that won't open with the keys a device holds (damaged, refused as written under an old key after a rotation, or from a newer app) is held: the device keeps what it had and any unsynced change. It is never treated as a deletion.
  - A notification sent at the moment of a rotation can still go out under the old key (sending can't be made atomic with the check); it reaches the partner's current devices only.
  - If a live record under an old key can't be re-encrypted by any device that holds the current keys (e.g. from a newer app), "Secure your space" stays in its re-encrypting step and a new rotation waits.
  - Changing keys can be switched off on the server (`ROTATION`), for example if a problem is found; it is on in production since review 0005 signed off.
  - A new partner who joins after the old one left receives the old space keys too, so can read history in a database copy (I4).
- Passkey unlock (ADR 0015) is off unless turned on. When it's on, one passkey both signs in and unlocks the keys, so anyone who can use that passkey on a new device can read everything: someone with your Apple, Google or password manager account plus a passcode of one of your devices, or your phone and its passcode. The server, or a copy of its database, can't open the sealed copy. Changing keys turns it off for every passkey. Don't share the passkey with your partner (a shared passwords group would open your private plans).
- Calendar feed consent is cooperative: `feed_share_busy` is a shared setting either member's device can write, so it records a choice rather than enforcing it (authorship isn't provable, above). When a partner leaves, their busy times leave the other person's feed the next time that person's app checks the member list, and their consent is cleared; a new invite and joining clear it too, so a new partner starts unasked; the busy markers they shared stay in the space, like everything else they shared, until the remaining member deletes them.
- Import restores only what this device has never seen, live or deleted, so it waits until this device has fully synced in the current session and checks again at the moment of writing (review 0004, condition A). Shared or not is decided by where a record will be written (a plan's privacy, a list's `private`, a child's parent), never by the file.
- Recurring rules come from the partner and from subscribed calendars, so expanding them is bounded: the series start is moved forward to just before the range asked for, COUNT is resolved once (and counts as at most 5000), lists in a rule are capped, and every expansion has a budget of periods; a feed has an overall time budget (review 0004, condition B). A COUNT series too sparse to finish within its budget (about 55 years of days or 400 of years) is cut short there.
- Ciphertext size buckets are 64 bytes; very long notes are distinguishable from short ones.
- The safety code is 9 digits (~30 bits). It is meant for an in-person comparison, not as protection against an attacker able to grind 2^30 invites per pairing attempt *and* replace the link.
