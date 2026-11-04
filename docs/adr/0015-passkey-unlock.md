# 0015. Passkey unlock

- Status: Accepted, pending its security review (review 0006)
- Date: 2026-11-04

## Context
A new device gets the keys from another device (a device link) or from the 12-word recovery phrase. People without another device at hand, including an iPhone's Home Screen app, which has its own storage, end up typing the phrase. That makes it feel like a password, which it was never meant to be.

Passkeys can produce a secret for a site after the person confirms with face, fingerprint or device passcode: the WebAuthn PRF extension (CTAP2 `hmac-secret`). Synced passkeys (iCloud Keychain, Google Password Manager, password managers) are on a person's new devices already.

## Decision
Opt-in, per passkey: a passkey can unlock the keys.

- **Sealing.** The device asks the passkey for `PRF(UNLOCK_SALT)`, where `UNLOCK_SALT = SHA-256("ours/passkey-unlock/v1")` is the same for every passkey. The sealing key is `HKDF(output, "ours/passkey-unlock/v1")`. The key ring is sealed with XChaCha20-Poly1305, AAD `(label | user_id | credential_id)`, and stored per passkey (`key_unlocks`). The PRF output never leaves the device: it's taken out of the WebAuthn result before anything is sent, and the end-to-end test checks the requests.
- **Unlocking.** Signing in with the passkey asks for the same output in the same touch; if the device has no keys and that passkey has a sealed copy, it's fetched and opened. "Unlock with a passkey" on the Welcome back screen does the same after an email sign-in.
- **Safeguards.** Off unless turned on, after a plain statement of what it means. User verification is required. Both setting it up and each unlock email the account owner. Removing the passkey removes its copy. Rotating keys (ADR 0013) deletes every copy, so a lost phone's synced passkey can't unlock the new keys; they're set up again on purpose. The app warns against sharing the passkey with the partner (a shared passwords group would open private plans). New passkeys are created with PRF enabled.
- **The recovery phrase stays** the way back when passkeys and devices are all gone.

## Consequences
- With it on, one passkey signs in **and** unlocks. Anyone who can use the passkey on a new device gets the keys: someone with the person's Apple, Google or password manager account plus a passcode of one of their devices, or their phone and its passcode. Without it, signing in alone gives only ciphertext. THREAT_MODEL says this.
- The server, or a copy of its database, gains nothing: the sealing key is 256 bits from the passkey.
- When the keys change (the partner rotates, or a new key arrives), a copy holds the old ones until the person uses the passkey again; the app says so.
- Passkeys without PRF (some older platforms) can sign in but not unlock; the app says so and the phrase or a device link still works.
