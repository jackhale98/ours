# 0013. Key rotation after losing a device or a partner leaving

- Status: Accepted. Signed off in security review 0005 after two re-reviews (see "After review 0005")
- Date: 2026-11-03

## Context
All of a person's devices share one key ring: their personal key and the space key, with versions. Removing a device ends its sessions, but the device may still hold those keys. Without rotation, anything it later obtains from the server (or from a database copy) it can read. Review 0001 (M1) requires that rotation re-encrypts live records, makes old versions decrypt-only, rejects new ciphertexts under old versions, and sends notifications only under the current version.

The hard part is delivery. The remaining devices share no secret that the removed device lacks: same ring, and the recovery phrase is never stored on any device. So a new key cannot be delivered by encrypting it under anything the ring already holds.

## Options
1. **Wrap the new keys under the old ones.** Simple, but the removed device (old keys) plus any server copy reveals the new keys. Rejected.
2. **Per-device X25519 keys, new keys wrapped to each remaining device.** Strong and seamless, but device public keys must be authenticated (else the server substitutes its own), which needs signatures or certificates bound at linking time and a new primitive (`@noble/curves`). A larger design that needs its own review; possible later.
3. **Deliver new keys out of band with the existing link mechanism.** The person who rotates gets a one-time link for their partner (like the first invite: secret in the URL fragment, wrapped blob on the server, claimed on first fetch, erased on use) and links their own other devices with the existing device link. The recovery phrase is replaced, because the old backup cannot contain the new keys. Partners compare the new safety code afterwards (review 0001, I4).

## Decision
Option 3, using only primitives and flows that have already been reviewed.

- **Rotate** (Privacy → "Secure your space", offered after removing a device, and available any time): the device generates space key v+1 and personal key v+1, adds them to its ring, and asks the server to raise the space's and the person's minimum key versions (`POST /spaces/:id/rotate` with the versions it is rotating from; the server allows exactly +1, which serialises version allocation per space, the deferred part of finding M2). It then re-encrypts every live record it can write (all space records, and its own personal records) under the new versions, through the normal sync push.
- **Old versions become decrypt-only.** The server rejects pushes and notifications sealed under a version below the minimum (409 `stale_key`). Devices keep old keys to read history, but refuse records under an old version whose server revision is newer than the rotation point (`rotated_rev`), so new data can never be under a key the removed device has.
- **The partner** gets the new space key from a one-time *key update link* (new invite kind `rekey`, AAD label separate from partner invites; claimable only by the other member of that space). Until they open it, their devices show that new keys are waiting and keep the plans they already have.
- **Own other devices** see that they need new keys and are re-linked with the existing device link.
- **New recovery phrase**: rotation finishes by making a new phrase and backup, since only that backup holds the new keys.
- **Safety code** changes with the space key; both people compare it again.

## Consequences
- After losing a phone, a person does three things: secure the space, send the link, write down the new phrase. The UI walks through it.
- The removed device cannot read anything written after rotation, even with a later copy of the database, because nothing after rotation is sealed under its keys and the server refuses old-version writes. It can still read what it already had, and history in D1 Time Travel (30 days) until that expires.
- A malicious server can delay or withhold the key update (denial of service), but cannot read the new keys: the link secret never reaches it. Devices keep the floor they have seen and never accept a lower one, pin the rotation point (`rotated_rev`) for a version the first time they learn it, and refuse a record whose key version is lower than the copy they already hold. A device that first hears of a rotation from a lying server can't check the rotation point it is given; see THREAT_MODEL.
- Option 2 remains a path to make rotation seamless later.

## After review 0005
The flow above is kept; review 0005 found its edges unsafe, and these were changed:
- **Order (H2).** Rotating is three steps, and the state of each is kept on the device so it resumes after a reload or a lost answer: (1) after a full sync, new keys are made and kept apart, never used to seal anything; (2) the new phrase is shown, two words are checked, and the backup is saved over old and new keys; (3) only then does the server make the new versions current. Re-encryption then runs until the server reports no live record below the new versions (`GET /spaces/:id/rotation`), and every device that holds the current keys re-seals what it has under old ones.
- **Exact versions and fingerprints (H1).** The server accepts writes, notifications and reminders under the current version only: not older, and not newer. A rotation records a fingerprint per new key, `kid = SHA-256(AAD(label, scope, owner, version) || key)[0..16]`, which `/me` returns. A device drops keys above the floor (a rotation that never happened), doesn't use a key whose fingerprint differs, and takes keys from a link only for the current version, only when it needs them, and only if the fingerprints match. The fingerprint is not in the record AAD: records keep their format, and the exact-version rule plus the checks above stop a device from sealing under a key that isn't the real one.
- **Atomic (M1).** The rotation is one batch behind a guard row that aborts it if either version moved.
- **Delivery (M3, M4).** Only the member who made the latest rotation can make key update links, for the current version, for 14 days after, as often as needed until the partner confirms holding the key (`POST /spaces/:id/keys-ack`, checked against the fingerprint). The partner sees the new safety code before the keys are used, and is then asked for a new recovery phrase. Rotating needs a recent sign-in or passkey check when the account has a passkey; both members are emailed.
- **Stale period (M5).** A device without the new keys keeps its stored copy of a record it can't open as the merge base, and pulls those records again once the keys arrive.
- **Housekeeping (L2, L4, L7).** Reminders and held notifications under old keys are deleted with the rotation; an account in more than one space can't rotate (the personal key is shared by all of them); the calendar feed link is replaced.
