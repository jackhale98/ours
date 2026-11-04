# 0015. Passkey unlock

- Status: Accepted. Signed off in review 0006 (see "After review 0006"); on in production
- Date: 2026-11-04

## Context
A new device gets the keys from another device (a device link) or from the 12-word recovery phrase. People without another device at hand, including an iPhone's Home Screen app, which has its own storage, end up typing the phrase. That makes it feel like a password, which it was never meant to be.

Passkeys can produce a secret for a site after the person confirms with face, fingerprint or device passcode: the WebAuthn PRF extension (CTAP2 `hmac-secret`). Synced passkeys (iCloud Keychain, Google Password Manager, password managers) are on a person's new devices already.

## Decision
Opt-in, per passkey: a passkey can unlock the keys.

- **Sealing.** The device asks the passkey for `PRF(UNLOCK_SALT)`, where `UNLOCK_SALT = SHA-256("ours/passkey-unlock/v1")` is the same for every passkey. The sealing key is `HKDF(output, "ours/passkey-unlock/v1")`. The key ring is sealed with XChaCha20-Poly1305, AAD `(label | user_id | credential_id)`, and stored per passkey (`key_unlocks`). The PRF output never leaves the device: it's taken out of the WebAuthn result before anything is sent, and the end-to-end test checks the requests made when signing in and when setting it up.
- **Unlocking.** Signing in with the passkey asks for the same output in the same touch; if the device has no keys and that passkey has a sealed copy, it's fetched and opened. "Unlock with a passkey" on the Welcome back screen does the same after an email sign-in.
- **Safeguards.** Off unless turned on, after a plain statement of what it means. The PRF output is used only when the authenticator data says the person was verified (face, fingerprint or passcode). Turning it off and each fetch of a copy email the owner every time (fetches are limited to ten an hour); turning it on emails at most once an hour. Removing the passkey removes its copy. Changing your keys (ADR 0013) deletes all your copies, and passkeys added before that can't unlock again, so a lost phone's synced passkey can't unlock the new keys. The app warns against sharing the passkey with the partner (a shared passwords group would open private plans). New passkeys are created with PRF enabled.
- **The recovery phrase stays** the way back when passkeys and devices are all gone.

## Consequences
- With it on, one passkey signs in **and** unlocks. Anyone who can use the passkey on a new device gets the keys: someone with the person's Apple, Google or password manager account plus a passcode of one of their devices, or their phone and its passcode. Without it, signing in alone gives only ciphertext. THREAT_MODEL says this.
- The server, or a copy of its database, gains nothing: the sealing key is 256 bits from the passkey.
- When the keys change (the partner rotates, or a new key arrives), a copy holds the old ones until the person uses the passkey again; the app says so.
- Passkeys without PRF (some older platforms) can sign in but not unlock; the app says so and the phrase or a device link still works.

## After review 0006
- **Old passkeys stay out (M1).** The server records when you last changed keys and refuses unlock copies for passkeys added before then. The app names passkeys by provider (from the AAGUID) and says which ones can unlock. "Update" is offered only for a copy this device set up; a copy set up elsewhere that holds older keys is pointed out instead. Before adding a passkey after losing a device, remove that device from your Apple, Google or password manager account: until then, a new passkey syncs to it too.
- **User verification is checked (M2)** on every path, by the UV flag in the authenticator data; the server-side confirmation used to set it up requires it too.
- **The switch covers everything (L1).** With `PASSKEY_UNLOCK` off, copies can't be set up, listed or fetched (turning one off still works). Switching it off doesn't delete copies; switching it back on brings them back.
- **Setting a copy needs that passkey (L2):** the session must have signed in or confirmed with that very passkey in the last ten minutes.
- **Out-of-date copies (L4):** each copy lists the key versions it holds, so any device can tell.
- **Accepted:** someone with a session token can still turn a copy off (it's emailed); the "a device asked to unlock" email goes out when a copy is fetched, because the server can't know whether it opened (L3).

## Passkeys whose app can't unlock

Some passkey apps sign in but don't support the PRF extension (older iOS, some password managers). When a passkey is added, the app's "PRF enabled" answer (a yes or no, never a secret) is stored as `passkeys.prf`. A passkey that gives no unlock secret when setting up unlocking is also remembered on that device. Either way it's listed as "signs in only: its app can't unlock keys", isn't offered for unlocking, and the person is told which passkey apps can.
