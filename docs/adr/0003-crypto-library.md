# 0003. Crypto library and protocol details

- Status: Accepted
- Date: 2026-11-03

## Context
All encryption happens on device in `packages/core/crypto`. The plan proposes `@noble/*` + `@scure/bip39` or `libsodium-wrappers`, and forbids hand-rolled primitives.

## Options
1. **@noble/ciphers, @noble/hashes, @scure/bip39**: pure TypeScript, tree-shakable, audited (Cure53 and others, per their READMEs), same maintainer family, no WASM.
2. libsodium-wrappers: battle-tested C via WASM, but ~180 KB+ and an async init step.
3. WebCrypto only: no XChaCha20-Poly1305; AES-GCM's 96-bit random nonces need more care.

## Decision
Option 1, pinned exactly (`@noble/ciphers` 2.4.0, `@noble/hashes` 2.4.0, `@scure/bip39` 2.4.0). Randomness comes from `crypto.getRandomValues` via noble.

Protocol details, decided here because they are not in the plan or refine it:

1. **AAD encoding.** Fields are length-prefixed (u32 big-endian) rather than joined with `|`, so no two field lists encode identically. Every AAD starts with a purpose label (`ours/record/v1`, `ours/invite/v1`, `ours/backup/v1`, `ours/notify/v1`).
2. **Record AAD** = `(label, space_id, record_id, scope, owner_user_id or "", key_version, "live"|"deleted")`. Ids must be ASCII `[A-Za-z0-9_-]`. *Deviation:* the plan lists `schema_version` in the AAD. The schema version is inside the ciphertext (authenticated already), so it is not in the AAD and the envelope does not need a plaintext schema column. `owner_user_id` is added so a user-scoped record cannot be relabelled to another user.
3. **Write metadata inside ciphertext.** `kind`, `schema`, `updated_at`, `device_id` and `deleted` are encrypted and authenticated, so conflict resolution cannot be steered by the server, and replays of old versions lose.
4. **Padding.** Plaintext is padded (ISO/IEC 7816-4) to 64-byte blocks before encryption to blur sizes.
5. **KDF.** HKDF-SHA256 with an empty salt and a per-purpose `info` label; all inputs are uniformly random 128–256-bit secrets.
6. **Recovery phrase.** 12 BIP39 English words = 128 bits of entropy. We use the entropy directly with HKDF and skip BIP39's PBKDF2 seed step, which only adds value for low-entropy passphrases. Input accepts any unambiguous 4-letter prefix.
7. **Invites.** The AAD binds `(label, kind, context_id)` where context is the space id (partner) or user id (device link); the decrypted payload must name the same id. The invite id is not in the AAD because the server assigns it after upload; each invite has its own secret, so blobs cannot be swapped between invites.
8. **Safety code.** First 64 bits of `SHA-256(AAD(label, space_id, key_version) ‖ key)` mod 10⁹, shown as `123 456 789`. Domain-separated from other uses of the key.
9. **Notifications** carry a random `nid` and an authenticated `not_before`/`expires_at` window (≤ 7 days); receivers allow 5 minutes of skew and drop duplicates.
10. **Scope policy.** `sealDecodedRecord` refuses busy-only events and private lists under the space key and busy stubs under a personal key; `openDecodedRecord` flags violations.
11. **Key versions are immutable.** A version number always maps to one key; `KeyRing` throws on conflicts.

## Consequences
- Labels and AAD layouts are protocol constants; changing one is a breaking change requiring migration and a new ADR. Frozen test vectors (recovery key derivation, safety code) guard against accidental changes.
- Crypto in the main bundle costs a few KB gzipped (the join page, which pulls in invite parsing, is under 1 KB of app code).
- Independent review: `docs/reviews/0001-core-crypto.md`.
