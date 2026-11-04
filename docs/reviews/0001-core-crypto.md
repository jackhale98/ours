# Review 0001: core crypto, schema and sync (phase 1)

- Reviewer: independent agent that did not write the code (per build plan §11)
- Date: 2026-11-03
- Scope: `packages/core/src/crypto/*`, `schema/{envelope,records,ids}.ts`, `sync/{merge,clock,protocol}.ts`
- Verdict: **Sign-off with conditions.** No Critical or High findings.

The reviewer verified independently: base64url decoder against Node's (200k random inputs, canonical only), the frozen recovery-HKDF and safety-code vectors with Node crypto, `__proto__` handling in validation, rejection sampling, and that `unpad` runs only after tag verification.

## Findings and resolution

| ID | Severity | Finding | Status |
|---|---|---|---|
| M1 | Medium | Old key versions stay valid for new writes and notifications, so rotation does not revoke a holder of the old key | **Closed (review 0005, re-review 2).** Rotation re-encrypts live records; the server refuses old-version writes, notifications and reminders (`stale_key`); devices refuse old-version records newer than the rotation revision; version allocation is serialised per space (+1 only). |
| M2 | Medium | Adding a key for an existing version silently replaced it | **Fixed.** `KeyRing` refuses conflicting keys for a version (`setOnce`). Collision-safe key ids bound into the AAD are deferred to the rotation design (phase 7), where the server will also serialise version allocation per space. |
| M3 | Medium | A rolled-back backup could be restored and then overwrite the good one | **Partly fixed.** `KeyRing.mergeFrom` merges rings with conflict detection; the backup writer (phase 3) must fetch, decrypt and merge the current backup before sealing, and keep the highest version seen. Test required with that code. |
| M4 | Medium | Invite link + stored blob = space key forever; single use is server policy only | **Open — documented** in THREAT_MODEL.md. Phase 2: delete blob on first fetch, 24 h expiry. Consider an ephemeral X25519 exchange authorised by the link (ADR needed). |
| M5 | Medium | Nothing tied private content to the user scope | **Fixed.** `sealDecodedRecord`/`openDecodedRecord` (`crypto/codec.ts`) enforce the scope policy on both ends. The app must use these, not raw `sealRecord`. Items in private lists must also be user scope; enforced in the app layer (list privacy is not visible to an item). |
| L1 | Low | Wire `deleted` flag unauthenticated | **Fixed.** `deleted` is in the record AAD and must match the encrypted tombstone. Clients must use decrypted metadata only (wire `updated_at`/`updated_by`/`rev` are for sync bookkeeping). |
| L2 | Low | Notifications replayable within ±24 h; window unsuitable for scheduled reminders | **Fixed.** Random `nid`, authenticated `not_before`/`expires_at` (≤ 7 days), 5 min skew; receiver de-duplicates by `nid`. |
| L3 | Low | Unbounded `updated_at` could freeze a record | **Fixed.** Max 2^48; `nextTimestamp` rejects non-safe inputs. |
| L4 | Low | Field merge was top-level only; merged data not re-validated; `__proto__` | **Fixed.** One extra level of recursion for nested objects (settings), null-prototype accumulator, unsafe keys skipped, result re-validated (falls back to LWW if invalid). |
| L5 | Low | Validation errors contained plaintext | **Fixed.** `RecordError` (paths only) and generic `CryptoError` for notifications. |
| L6 | Low | Push items could name a different space than the request | **Fixed** in `PushRequest`. Server test for owner = caller is a phase 2 requirement. |
| L7 | Low | Truncation test hit the length check, not the tag | **Fixed** (`review.test.ts`). |
| I1 | Info | Lone surrogates collide in AAD | **Fixed.** Ids in AAD must match `[A-Za-z0-9_-]{1,64}`. |
| I2 | Info | No per-purpose subkeys (separation by AAD label only) | Accepted for now; revisit with rotation. |
| I3 | Info | XChaCha20-Poly1305 is not key-committing | Accepted. Rule: never trial-decrypt across keys or versions (the key is selected by header). |
| I4 | Info | Safety code proves key equality only | Documented. Must be re-compared after rotation. |
| I5 | Info | Partners can impersonate each other's `author` | Documented in THREAT_MODEL.md. |
| I6 | Info | UUIDv7 ids reveal creation time | Covered by the metadata section. |
| I7 | Info | No size cap on invite/backup blobs before decrypt | To enforce at the API (phase 2) and client fetch. |

Tests added in response: known-answer vectors for record AAD bytes, a record ciphertext, invite HKDF and notification AAD; cross-context rejection (record ↔ notification, backup ↔ device invite, partner ↔ device invite); tombstone flip; version conflicts and ring merge; scope policy; nested and `__proto__` merges; timestamp bounds; error redaction.

## Conditions carried forward

1. M1 before key rotation ships (phase 7).
2. M3 backup merge-on-write with a test (phase 3).
3. M4 blob deletion on first fetch (phase 2) and an ADR on ephemeral pairing.
4. Phase 2 Worker test: user-scope `owner_user_id` must equal the caller.
5. Re-review `crypto/codec.ts` usage when the app's sync engine lands.
