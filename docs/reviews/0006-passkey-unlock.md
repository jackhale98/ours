# Review 0006: passkey unlock (ADR 0015)

- Reviewer: independent agent that did not write the code (build plan §11)
- Date: 2026-11-04
- Scope: commit f0fd11f, checked against ADR 0015, ADR 0013 and review 0005 (fingerprints, N5), and THREAT_MODEL:
  - core: `packages/core/src/crypto/unlock.ts` and its test, `kdf.ts`, `aead.ts`, `aad.ts`, `bundle.ts`
  - server: `migrations/0009_passkey_unlock.sql`, `routes/keys.ts` (unlock routes), `routes/spaces.ts` (`rotateStatements`), `routes/auth.ts` (passkey login, reauth, passkey delete), `routes/me.ts`, `lib/accounts.ts`, `wrangler.jsonc` (`PASSKEY_UNLOCK`)
  - client: `apps/web/src/account/session.ts` (`signInWithPasskey`, `prfRequest`, `takePrf`, `unlockCeremony`, `unlockWith`, `unlockThisDevice`, `enablePasskeyUnlock`, `disablePasskeyUnlock`, `removePasskey`, `loadPasskeys`, `addPasskey`, `commitStaged`, `refresh`), `app/views/AccountCards.tsx` (`PasskeysCard`), `app/views/Start.tsx` (`RestoreKeys`)
  - docs: ADR 0015, THREAT_MODEL, `apps/web/legal/privacy/index.html`
  - tests: `apps/api/test/unlock.test.ts`, the last test in `apps/web/e2e-sync/pair.spec.ts`
- Verdict: **Sign-off with conditions.** Fix M1 and M2, L1 and L4, and the docs in L5, with tests. Fix L2 and L3 or record them in THREAT_MODEL. Until then `PASSKEY_UNLOCK` stays `off` in production. See "Sign-off" at the end.

The reviewer ran the existing suites, all green: `pnpm test:api` (104 tests), `TZ=UTC pnpm test` (688) and `e2e:sync` (3, including the passkey test). Two throwaway probes ran and were then deleted:

- an API probe (`apps/api/test/`), called Q1–Q4 below;
- an end-to-end probe with a virtual PRF passkey, called E1 below. It turned unlocking on, signed out, overwrote the stored copy in local D1 with random bytes, then signed in with the passkey.

Nothing in the repo changed apart from this file.

## Summary

The cryptography is sound. The sealing key comes from a 256-bit PRF output through HKDF. The AAD binds the user and the credential. Each seal uses a fresh random nonce. The derived key and the PRF copy are zeroed. The PRF output never reaches the server: it is removed from the sign-in response before sending, the PUT carries only nonce and ciphertext, and request logs record only the route pattern. A swapped, garbage or old copy never gets a device to use wrong keys: it fails to open, or `refresh` applies the floor and fingerprint checks from review 0005.

The server routes are scoped per user and check passkey ownership. A copy goes when its passkey or account goes. Rotation deletes the rotator's copies in the same all-or-nothing batch.

The weak points are about the lost phone, which is what rotation is for, and about what the docs promise:

- Rotation deletes the copies, but nothing stops unlocking from being turned on again with a passkey the lost phone still holds. The app can't tell passkeys apart. Its advice ("remove passkeys the lost phone could use") is not enough for synced passkeys: a new passkey syncs to the phone too while the phone is still in the Apple, Google or password manager account. The lost phone can also re-create a copy right after rotation, and that makes the person's other devices show "Your keys changed… Update" (M1).
- The sign-in path asks for the PRF output with user verification only *preferred*, and doesn't check the UV flag. ADR 0015 says user verification is required (M2).

The rest is smaller:

- The switch doesn't stop unlocks (L1).
- Any session can overwrite or silently delete a copy (L2).
- The emails are sent when a copy is fetched, not when it opens. Any session can trigger up to 30 an hour (L3).
- Only the device that made a copy can tell that it is out of date (L4).
- Several sentences in the ADR, THREAT_MODEL, UI and privacy policy say more than the code does, or leave out what the person must do (L5).

**Answers to the questions in scope, in short.**

- *PRF output reaching the server, logs or storage:* no (E1, Q3 logs, reading). See I3 for zeroing.
- *Key derivation:* sound. The fixed salt is a deliberate trade-off (I1).
- *Making a device adopt a wrong ring:* no. Copies swapped between users or passkeys fail to open. An old copy is used, but `refresh` then keeps the device on its old keys with the "needs new keys" banner, and a key whose fingerprint differs is never used. This holds against an honest server; against a lying server, the N5 residual from review 0005 applies (I2).
- *Authorisation:* correct scoping and ownership. The switch has a gap (L1). Overwrite and delete need no proof of the passkey (L2). Emails can be triggered by any session (L3).
- *Rotation:* the rotator's copies are deleted, atomically. The partner's copies stay, which is fine, but the docs say "every passkey" (L5). A copy can be re-created by the lost phone at once, and the person can be led to seal the new keys under a passkey the phone holds (M1).
- *Different PRF output:* fails safe and falls back to Welcome back (E1). The error shown is "Decryption failed" (I5).
- *Docs:* see M1, M2 and L5.

| ID | Severity | Finding | Verified |
|---|---|---|---|
| M1 | Medium | After rotation, unlocking can be turned on again (or "Update"d) with a passkey the lost phone holds. The app can't tell passkeys apart, its advice misses synced accounts, and the lost phone can re-create a copy that makes other devices ask for an update | Test (Q2) + reading |
| M2 | Medium | The sign-in unlock uses `userVerification: 'preferred'` and doesn't check the UV flag, so a provider that skips UV can release the keys without face, fingerprint or passcode | Reading |
| L1 | Low | `PASSKEY_UNLOCK` gates only setting up. Fetching and listing copies still work when it's off, so it isn't a kill switch | Test (Q1) |
| L2 | Low | Any session can overwrite a copy with garbage or delete it. Delete sends no notice | Test (Q3) |
| L3 | Low | "Your keys were unlocked" is sent on fetch, even when nothing opens. Any session can send 10 of those and 20 "unlock is on" emails an hour | Test (Q3, E1) |
| L4 | Low | Out-of-date copies are detected only on the device that made them. A device unlocked by passkey never shows "Update" | Reading |
| L5 | Low | Docs and UI overstate or leave things out (rotation "every passkey", UV, the e2e check, emails, password managers, privacy policy) | Reading |
| I1–I6 | Info | See below | — |

## Verified correct

- **PRF output stays on the device.**
  - `takePrf` (`session.ts:1155`) copies `prf.results.first` and deletes `prf` from the extension results *before* `/auth/passkey/login/verify` is called (`:315`). `@simplewebauthn/browser` 14 returns `getClientExtensionResults()` as is, so the deletion removes it from the body. An `ArrayBuffer` would serialise to `{}` anyway.
  - E1: no request body after sign-in matched `"prf"` or `"results"`. The enable PUT body is exactly `{ wrapped: { nonce, ciphertext } }`.
  - Request logs record the route pattern (`/keys/unlock/:id`), method, status and time only (Q3).
  - The web app has no error reporter. Error paths throw `CryptoError` or `ApiError` messages, which carry no key material.
  - `prf.fill(0)` runs in a `finally` on all three paths (sign-in, Welcome back, enable).
- **Derivation and sealing.**
  - `UNLOCK_SALT = SHA-256("ours/passkey-unlock/v1")`. WebAuthn hashes it again with its own `"WebAuthn PRF\0"` prefix, so it can't collide with another site's input.
  - The sealing key is HKDF-SHA256 with an empty salt and its own info label. That is fine for a uniformly random 32-byte input. Shorter outputs are refused.
  - The key is zeroed in a `finally`. Each seal draws a fresh 24-byte XChaCha20-Poly1305 nonce.
  - The AAD is length-prefixed `(label, user_id, credential_id)`. `openUnlock` also checks the ring's `user_id`. Core tests cover another output, user and credential.
- **Swaps and replays.**
  - A copy moved to another user fails twice: the server scopes by `user_id`, and the AAD binds the user.
  - A copy moved to another passkey of the same user fails: the AAD binds the credential, and the PRF output differs.
  - E1: a copy that doesn't open leaves the device in Welcome back with nothing saved. "Unlock with a passkey" shows an error and stays there.
  - An old copy (from before a rotation) opens. `unlockWith` then calls `refresh`, which runs `learnFloor`, `dropUnconfirmed` (keys above the floor are dropped) and `activeRing` (a key whose fingerprint differs is not used). So the device works with the old keys and shows the "needs new keys" banner. It never seals under a key the server didn't record.
  - `unlockWith` acts only in `needs-keys`, that is, when the device has no space keys. It can't replace keys a working device holds.
- **Server routes.**
  - All four routes are scoped by `user_id`.
  - PUT checks that the passkey belongs to the caller (`EXISTS … AND user_id`), and the upsert is guarded by `key_unlocks.user_id`. PUT is refused when the switch is off.
  - Rate limits: 20 PUTs and 10 GETs per user per hour (Q3).
  - `/me` reports the switch.
- **Removal and rotation.**
  - Deleting a passkey removes its copy (`ON DELETE CASCADE`, API test). Deleting the account removes them too (Q4).
  - `rotateStatements` deletes the rotator's copies in the same batch as the rotation. The batch is led by the guard row, so a refused rotation deletes nothing.
  - `commitStaged` clears the local versions, so the rotating device shows no "Update" prompt.
  - The partner's copies stay after the other person rotates (Q4). They hold the old shared key, which the partner has anyway.
- **IDs.** Sign-in uses `response.id` and the other paths use `toBase64Url(rawId)`. Both are unpadded base64url and match the stored `passkeys.id` (the e2e test round-trips it).
- **Production.** `PASSKEY_UNLOCK` is `"off"` in the production environment (`wrangler.jsonc:73`) and `"on"` only locally.

## Findings

### M1 (Medium): rotation's protection can be undone by turning unlocking on again with a passkey the lost phone holds

- **Location:**
  - `PasskeysCard` (`AccountCards.tsx:181`: passkeys are shown only as "Passkey 1", "Passkey 2"; `:221`: the "Update" prompt; `:277`: the advice);
  - `loadPasskeys` (`session.ts:1258–1272`);
  - `keys.put('/unlock/:id')` (`keys.ts:108`);
  - ADR 0015 "Safeguards"; THREAT_MODEL "Passkey unlock".
- **What happens:** rotation deletes the copies so "a lost phone's synced passkey can't unlock the new keys". That holds only until unlocking is turned on again with a passkey the phone can use. Several things make that likely:
  - **The advice is incomplete.** The card says "Remove passkeys the lost phone could use before turning it on again." A synced passkey is on every device signed in to the same Apple, Google or password manager account. While the lost phone is still signed in to that account, a *new* passkey syncs to it too. The person must first remove the phone from that account (or change its password). Nothing says so.
  - **The person can't tell which passkey is which.** The list shows "Passkey N · added <date>". It doesn't show the provider, or whether the passkey existed before the rotation.
  - **The lost phone can re-create a copy right after the rotation.** It can sign in again with the synced passkey (the residual risk from review 0005, M4) and PUT a copy of the old ring. Q2: a session made long ago, with no recent sign-in, re-created a copy at once after the rotation. The only notice is "Passkey unlock is on", which the person may take for their own earlier setting. That copy holds only old keys, so it can't leak new data by itself. But any other device of the person's that once set up that passkey still has its old version in `unlock-versions`. Once that device has the new keys, it sees a copy behind them and shows "Your keys changed. Use your passkey again so it unlocks the new ones. **Update**." Pressing Update seals the new ring under the passkey the lost phone holds.
  - **Nothing ties a copy to the rotation.** The server accepts a copy for a passkey added before the latest rotation with no question asked.
- **Impact:** a thief who has the phone and its passcode, which is the case rotation exists for, can read everything written after the rotation. The app nudges the person towards this.
- **Fix:**
  1. Say what to do, in the Secure card, the Passkeys card, ADR 0015 and THREAT_MODEL: "Before turning passkey unlock on again, remove the lost phone from your Apple, Google or password manager account. Until then, any passkey you make syncs to it."
  2. After a rotation, mark passkeys added before it ("added before you changed keys"). Turning unlocking on, or Update, for one of them needs an explicit confirmation of step 1. The server can supply `rotated_at` and the passkey's `created_at`.
  3. Show something that tells passkeys apart: the provider name from the AAGUID, and the device that added it.
  4. Show "Update" only for a copy this device made: compare the server's `created_at` with the one this device recorded. A copy made elsewhere should say "A copy was set up on another device" instead.
- Tests: after a rotation, a copy made by another session doesn't produce an "Update" prompt; enabling a passkey added before the rotation asks for the confirmation.

### M2 (Medium): user verification isn't enforced on the sign-in unlock

- **Location:** `auth.ts:311` (`generateAuthenticationOptions({ userVerification: 'preferred' })`); `signInWithPasskey` (`session.ts:304–331`), which uses the PRF output without checking the UV flag in `authenticatorData`.
- **What happens:** ADR 0015 says "User verification is required". `unlockCeremony` asks for `'required'`, but the main path is the sign-in, which asks for `'preferred'`. The server's `requireUserVerification: false` is right for sign-in alone. But the client then opens the keys with whatever PRF output came back.
  - For a CTAP2 security key, the output without UV is different (`CredRandomWithoutUV`), so the copy doesn't open. That fails safe.
  - Software providers (some password managers) may skip UV under `'preferred'` while their vault is unlocked, and give the same PRF output either way. Then the keys open with no face, fingerprint or passcode.
  - The reviewer could not reproduce this with Chrome's virtual authenticator: with UV switched off, it refused the whole ceremony.
- **Impact:** anyone who can use an unlocked password manager (a shared or unattended computer) gets the keys in one click. The stated safeguard doesn't hold.
- **Fix:** in `signInWithPasskey`, read the flags byte (`authenticatorData[32] & 0x04`) and use the PRF output only when UV is set. Otherwise leave the device in Welcome back, where "Unlock with a passkey" asks for UV. Do the same check in `unlockCeremony`, so a provider that ignores `'required'` is caught too. Test with a mocked response that has the UV flag cleared.

### L1 (Low): the switch doesn't stop unlocks

- **Location:** `keys.ts:98` (`GET /unlocks`), `:153` (`GET /unlock/:id`), `:180` (`DELETE`); `signInWithPasskey` asks for PRF and fetches regardless of `passkey_unlock`.
- **What happens:** only PUT checks `PASSKEY_UNLOCK`. Q1: with the switch off, an existing copy is still listed and fetched (200). If it is ever turned on and then off because of a problem, devices keep unlocking from the copies already stored.
- **Fix:** refuse `GET /unlock/:id` with 403 `unlock_off` when the switch is off, and have the client skip the PRF request and the fetch when `/me` says off. Keep `DELETE` and the list working, so people can still turn it off. Write down in ADR 0015 whether turning the switch off should also delete the copies. Test the GET when off.

### L2 (Low): any session can overwrite or silently delete a copy

- **Location:** `keys.ts:108` (PUT), `:180` (DELETE).
- **What happens:** the server can't tell whether the copy came from the passkey. Q3: a second session of the same user replaced a working copy with random bytes (200). The owner's next passkey sign-in then quietly falls back to Welcome back. DELETE needs no proof either, and sends no email. A thief with a session, or with the email inbox, can quietly take away the one-touch way back. Data is not at risk: the phrase and device links still work.
- **Fix:** accept PUT and DELETE only from a session that signed in with that passkey, or confirmed with it (`/auth/passkey/reauth`) in the last 10 minutes. Record the passkey id on the session for this. Email on DELETE too. Or record the risk in THREAT_MODEL.

### L3 (Low): the unlock emails are sent on fetch and can be triggered by any session

- **Location:** `keys.ts:142–148` (PUT notice), `:164–170` (GET notice).
- **What happens:**
  - "Your Ours keys were unlocked with a passkey" is sent when the sealed copy is *fetched*. E1: it was sent although the copy didn't open and the device stayed locked.
  - Any session can trigger 10 of these an hour, and 20 "Passkey unlock is on" emails an hour, with no passkey (Q3). The emails go only to the owner, so they can't be aimed at someone else. But a flood of them trains people to ignore them, or alarms them for no reason. Each tells the person to "change your keys".
- **Fix:** word the GET email as "A device asked for your passkey unlock copy". Or send it after the client reports success (`POST /keys/unlock/:id/used`), keeping a fallback email on fetch. Send at most one notice of each kind per hour.

### L4 (Low): only the device that made a copy knows it's out of date

- **Location:** `loadPasskeys` (`session.ts:1258–1272`), with `unlock-versions` kept in local storage only.
- **What happens:** ADR 0015 says that when the keys change "a copy holds the old ones until the person uses the passkey again; the app says so". It says so only on the device that made the copy. A device that was itself unlocked with the passkey, or set up by a device link, has no record and never shows "Update". Also, "Update" runs a ceremony with no `allowCredentials`, so the person can pick a different passkey and the old copy stays behind.
- **Fix:** store the key versions (or fingerprints) a copy holds as plain metadata with it (`key_unlocks.space_version`, `personal_version`). They are not secret: the server knows the floors. Compare them with `/me` on any device. Pass the stale passkey in `allowCredentials` for Update.

### L5 (Low): docs and UI say more than the code does, or leave things out

- **ADR 0015 and THREAT_MODEL, "Changing keys turns it off for every passkey" / "deletes every copy".** Only the rotator's copies are deleted (`spaces.ts:101`, Q4). Say "every passkey of the person who changes the keys". The partner's copies keep the old shared key until they press Update.
- **ADR 0015, "User verification is required".** Not on the sign-in path (M2).
- **ADR 0015, "the end-to-end test checks the requests".** It checks only the sign-in requests, not the enable PUT. E1 checked the PUT; add that to the test.
- **ADR 0015, "each unlock emails the account owner".** It is each fetch (L3).
- **The UI and THREAT_MODEL name "your Apple, Google or password manager account plus a passcode of one of your devices".** For many password managers, the master password alone, or an unlocked vault, is enough. No device passcode is involved. Say "or your password manager and its master password".
- **The lost-phone step (M1)** is missing from every document.
- **Privacy policy, "What we cannot see".** "We store your key backup only in a form sealed with that phrase" is still true of the backup. But it should add: "If you turn on passkey unlock, we also store a copy sealed with a key only your passkey can produce". The policy should also say the server sees when a copy is fetched. The table row itself is accurate.
- **THREAT_MODEL** should record I1 and I2 below, and L2 and L3 if they are accepted.

### Info

- **I1: the fixed salt means a passkey's sealing key never changes.** This is needed for one-touch unlock with a discoverable passkey: the device can't know which passkey will answer, so it can't ask for a per-passkey salt. The consequence is that a PRF output captured once opens every later copy for that passkey, including copies made after a rotation. It could be captured by a malicious browser extension, or by script injected into the app. Say in THREAT_MODEL that after such a compromise the passkeys must be replaced, not just the keys.
- **I2: no freshness in the AAD.** A server can serve an old copy, or withhold it. With honest fingerprints, the result is only "needs new keys" (verified above). A lying server is the N5 residual already recorded. Adding the versions to the AAD later would let the client refuse an old copy outright.
- **I3: zeroing is best-effort.** `takePrf` zeroes its copy, but the `ArrayBuffer` in the browser's extension results is left as it is. It can be zeroed too (`new Uint8Array(first).fill(0)`). The serialised ring and HKDF's internal state aren't zeroed. This is normal for JavaScript.
- **I4: `unlockCeremony` relies on the default `rpId`** (the page's hostname). That matches production (`RP_ID` `ourplanner.app`, served at `ourplanner.app`). A self-hosted instance whose `RP_ID` is a parent domain would find no passkeys there. Pass the RP id from the server.
- **I5: error message.** A copy that doesn't open shows "Decryption failed" (E1). Say "That passkey couldn't unlock your keys. It may be a different passkey, or it was used without face, fingerprint or passcode. Use a device link or your recovery phrase."
- **I6: test gaps.** Nothing tests:
  - a copy that doesn't open (fallback);
  - the UV flag;
  - the enable PUT body;
  - an old copy after a rotation going through `refresh`;
  - the switch on GET;
  - the "Update" prompt.

  One more thing: removing a passkey is a single tap on "×" with no confirmation, and it also deletes that passkey's copy.

## Sign-off

**Sign-off with conditions.** The design and the cryptography are sound. Nothing found lets the server, or a session alone, read keys or get a device to use wrong keys. The conditions are about the lost-phone case and about the promises in the docs.

Conditions, with tests:

1. M1: the lost-phone step in the UI and docs, the "added before you changed keys" confirmation, and "Update" only for copies this device made.
2. M2: use the PRF output only when the UV flag is set, on both paths.
3. L1: the switch also stops fetching copies, and the client skips the request when it's off.
4. L4: copy versions stored with the copy and compared on every device.
5. L5: correct ADR 0015, THREAT_MODEL, the Passkeys card and the privacy policy as listed, including I1 and I2 in THREAT_MODEL.
6. L2 and L3: fix them, or record them as accepted risks in THREAT_MODEL.

**`PASSKEY_UNLOCK` must stay `off` in production until conditions 1–6 are met.** After that, a check of the fixes is enough to turn it on. A new full review is not needed.
