# Review 0006: passkey unlock (ADR 0015)

- Reviewer: independent agent that did not write the code (build plan §11)
- Date: 2026-11-04
- Scope: commit f0fd11f, checked against ADR 0015, ADR 0013 and review 0005 (fingerprints, N5), and THREAT_MODEL:
  - core: `packages/core/src/crypto/unlock.ts` and its test, `kdf.ts`, `aead.ts`, `aad.ts`, `bundle.ts`
  - server: `migrations/0009_passkey_unlock.sql`, `routes/keys.ts` (unlock routes), `routes/spaces.ts` (`rotateStatements`), `routes/auth.ts` (passkey login, reauth, passkey delete), `routes/me.ts`, `lib/accounts.ts`, `wrangler.jsonc` (`PASSKEY_UNLOCK`)
  - client: `apps/web/src/account/session.ts` (`signInWithPasskey`, `prfRequest`, `takePrf`, `unlockCeremony`, `unlockWith`, `unlockThisDevice`, `enablePasskeyUnlock`, `disablePasskeyUnlock`, `removePasskey`, `loadPasskeys`, `addPasskey`, `commitStaged`, `refresh`), `app/views/AccountCards.tsx` (`PasskeysCard`), `app/views/Start.tsx` (`RestoreKeys`)
  - docs: ADR 0015, THREAT_MODEL, `apps/web/legal/privacy/index.html`
  - tests: `apps/api/test/unlock.test.ts`, the last test in `apps/web/e2e-sync/pair.spec.ts`
- Verdict (final check, commit ad1ddd4, 2026-11-04): **Sign-off.** N1 and N2 are fixed. N3, N4 and I8 are addressed. `PASSKEY_UNLOCK` can be turned on in production. Two small follow-ups remain, neither blocking: stale "once an hour" wording (F1), and one refusal that is wrong after changing spaces (F2). See "Final check" at the end.
- Verdict (check of the fixes, commit fb1e20e, 2026-11-04): sign-off with conditions. All six conditions are met. The fixes add one small regression (N1: "Confirm it's you" now fails for passkeys that skip user verification) and leave new stored data out of the docs (N2). Fix both, then `PASSKEY_UNLOCK` can be turned on in production. See "Check of the fixes" at the end.
- First verdict (2026-11-04): sign-off with conditions. Fix M1 and M2, L1 and L4, and the docs in L5, with tests. Fix L2 and L3 or record them in THREAT_MODEL. Until then `PASSKEY_UNLOCK` stays `off` in production.

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

## Fixes for the conditions

| Item | Fix | Test |
|---|---|---|
| M1 | `users.keys_changed_at` is set by the rotate batch; `PUT /keys/unlock/:id` refuses (409 `passkey_too_old`) a passkey added before it, and `/auth/passkeys` says which can unlock (`can_unlock`). Passkeys are named by provider (AAGUID, stored at registration). "Update" shows only for a copy this device set up (it remembers the copy's `created_at`); a behind copy set up elsewhere gets "If you don't recognise it, remove that passkey". The advice to remove the lost device from the Apple, Google or password manager account first is in the Passkeys card, ADR 0015 and THREAT_MODEL. Only eligible passkeys are offered when turning it on. | API "goes with the passkey and a change of keys, and old passkeys stay out"; web `passkeys.test.ts` "tells which copies are current, behind, or set up elsewhere" |
| M2 | The PRF output is used only when the authenticator data's UV flag is set: at sign-in, on Welcome back, and when setting it up. Setting it up goes through `/auth/passkey/reauth/verify`, which now requires user verification. | Web `passkeys.test.ts` "uses the unlock secret only when the person was verified" |
| L1 | With the switch off, `GET /keys/unlocks` and `GET /keys/unlock/:id` refuse (403 `unlock_off`) as well as `PUT`; `DELETE` still works. The client doesn't fetch or list when `/me` says off. ADR 0015 says switching off doesn't delete copies. | API "when off, nothing can be set up, listed or fetched" |
| L2 | `PUT` needs a session that signed in or confirmed with that very passkey in the last ten minutes (`sessions.passkey_id`, set at passkey sign-in and confirmation). `DELETE` emails the owner. Turning a copy off from a stolen session is recorded as accepted in THREAT_MODEL. | API "keeps one sealed copy per passkey…" (403 before confirming), "needs a confirmation from the last ten minutes" |
| L3 | The fetch email now says "A device asked to unlock…", and each kind of notice goes at most once an hour. Recorded in THREAT_MODEL. | API (email subject) |
| L4 | Each copy stores the key versions it holds (`space_version`, `personal_version`); every device compares them with its own. | API (listed versions); web status test |
| L5 | ADR 0015, THREAT_MODEL, the Passkeys card and the privacy policy ("What we cannot see") corrected as listed. The end-to-end test now also checks the requests made when setting it up. | E2E |
| I1, I2 | Recorded in THREAT_MODEL. | — |
| I5 | A copy that won't open says so in words and points to a device link or the phrase. | Reading |

## Check of the fixes (commit fb1e20e)

- Date: 2026-11-04. Scope: `git show fb1e20e`, read against the table above, which was treated as claims to check.
- Suites at HEAD, all green: `pnpm test:api` (105), `TZ=UTC pnpm test` (691), `e2e:sync` (3). The other browser e2e projects were not run again.
- One throwaway API probe ran and was deleted. It is called R1–R3 below:
  - R1: a rotation, then a lost phone that signs in again;
  - R2: two fetches of a copy within one hour;
  - R3: a copy replaced by one with lower versions.

### Items

| Item | Verdict | Notes |
|---|---|---|
| M1 | **Fixed** | The rotate batch sets `users.keys_changed_at` (`spaces.ts:91`), inside the guarded batch. `PUT` refuses a passkey added before it with 409 `passkey_too_old` (`keys.ts:164–175`). `/auth/passkeys` returns `can_unlock` and `aaguid`. R1: after a rotation, a session with no passkey gets 403. A session signed in with the old passkey gets 409. So the lost phone can no longer re-create a copy. `unlockStatus` offers "Update" only when this device recorded the copy's `created_at`. A copy made elsewhere is "behind-elsewhere", and no button is shown for it. The advice about the Apple, Google or password manager account is in the card, ADR 0015 and THREAT_MODEL. The author blocked old passkeys on the server instead of asking for a confirmation. That is stronger for old passkeys. For new passkeys, see N3. |
| M2 | **Fixed** | The UV flag (`authenticatorData[32] & 0x04`) is checked before the PRF output is used: at sign-in (`session.ts:319`), on Welcome back (`:1215`) and when setting up (`:1297`). Set-up also asks for `'required'`, and `/auth/passkey/reauth/verify` now verifies with `requireUserVerification: true`. Unit test of `userVerified`. **New:** see N1. |
| L1 | **Fixed** | `requireOn` guards `GET /unlocks`, `GET /unlock/:id` and `PUT`. `DELETE` still works. The client skips the list, the fetch and the sign-in unlock when `/me` says off. API test. Sign-in still asks the passkey for a PRF output when off, but it is discarded, so this is harmless. |
| L2 | **Fixed** | `sessions.passkey_id` is set at passkey sign-in and at confirmation. `PUT` needs that passkey, with sign-in or confirmation in the last 10 minutes (`keys.ts:161`). R1 and the API tests confirm it. `DELETE` emails the owner. Turning a copy off from a stolen session is recorded as accepted in THREAT_MODEL. |
| L3 | **Fixed, one gap** | The wording is now "A device asked to unlock…", and it says the server can't tell whether the copy opened. Each kind of notice is capped at one per user per hour. The cap can hide a second fetch made in the same hour (N4). |
| L4 | **Fixed** | Each copy stores `space_version` and `personal_version`. They are listed and compared with this device's versions on every device. "Update" passes the one passkey (`only`) in `allowCredentials`. Note: the versions come from the client, and a copy can be replaced by an older one (R3, I8). |
| L5 | **Mostly fixed** | ADR 0015, THREAT_MODEL, the Passkeys card and the privacy policy's "What we cannot see" now say what the code does: the rotator's copies, UV, emails, password managers, the lost-phone step. The e2e test now records the set-up requests, checks that one carries `space_version`, and checks that none carries `"prf"` or `"results"`. Still missing: the privacy policy doesn't say that the server sees when a copy is fetched. The data tables leave out the new columns (N2). |
| I1, I2 | **Recorded** | In THREAT_MODEL's residual risks. |
| I5 | **Fixed** | A copy that won't open now says so in words and points to a device link or the phrase. |

### New findings

**N1 (Low, regression): "Confirm it's you" now fails for passkeys that skip user verification.**

- Location: `auth.ts:401` (`/passkey/reauth/options` still asks for `userVerification: 'preferred'`); `auth.ts:411` (verify now requires UV); `confirmItsYou` (`session.ts:774`), which passes the server's options unchanged.
- What happens: `confirmItsYou` is used before changing keys, before saving a new phrase, and before adding a passkey (`AccountCards.tsx:309, :573, :600`). Two kinds of passkey can now answer without UV under `'preferred'`:
  - a security key with no PIN;
  - a provider that skips UV when it is asked only to prefer it.

  Their answer is then refused with `passkey_invalid`, where it used to work. The person gets an unclear error during a security action. They can still sign in again by email.
- Fix: ask for `userVerification: 'required'` in `/passkey/reauth/options`, so the browser asks for face, fingerprint or PIN, or says it can't. Show "This passkey can't confirm with face, fingerprint or PIN; sign in again by email instead" when the check fails.

**N2 (Low, docs): new stored data is missing from THREAT_MODEL and the privacy policy.**

- The migration adds four columns:
  - `passkeys.aaguid`: which provider holds each passkey, such as iCloud Keychain, Google Password Manager or 1Password;
  - `sessions.passkey_id`: which passkey each session used;
  - `users.keys_changed_at`;
  - `key_unlocks.space_version` and `personal_version`.
- THREAT_MODEL's table (lines 41, 42 and 48) and the privacy policy's "Passkey public keys" row don't list them.
- The AAGUID is collected at every passkey registration, whether or not unlocking is switched on. It is new information about the person (their password manager).
- Also add the L5 item: the server sees when a copy is fetched.

**N3 (Low): the age check is about time, not about who added the passkey.**

- R1: a lost phone that signs in again with its old passkey can still start adding a new passkey (`register/options` 200). A passkey the person adds while the lost phone is still in their Apple or Google account also syncs to the phone.
- Either kind passes `can_unlock`. Then only the advice text protects the person: it is shown on the card, but nothing stops them at the moment they add a passkey or turn unlocking on. The thief still needs the owner to seal the new keys under that passkey, and the owner gets "A passkey was added" by email.
- Fix (recommended, not a condition): after a rotation, the first "Add a passkey" and "Let a passkey unlock my keys" ask once: "Is the lost device out of your Apple, Google or password manager account?" Also consider stopping passkeys added before the rotation from adding new ones.

**N4 (Low): the hourly notice cap can hide a second fetch.**

- Location: `notice` (`keys.ts:108–115`): one email per kind per user per fixed hour.
- R2: the owner fetched the copy, and then another session fetched it. Both fetches returned 200, but only one email was sent. So a thief who unlocks within the same hour as the owner, or just after another notice of the same kind, goes unnoticed. That weakens "so an unlock someone else tried doesn't go unnoticed".
- Fix: cap per kind *and* session or device (so a different device always gets its own email), or allow a few an hour and fold the rest into "and N more". THREAT_MODEL's "at most once an hour" should say what the cap can hide.

### Info

- **I7:** `passkeys.ts` names providers only from a short built-in AAGUID list. Some providers send an all-zero AAGUID, which falls back to "Passkey N". That is fine, but people won't always see a name.
- **I8:** `PUT` accepts a copy whose versions are lower than the copy it replaces (R3). A behind device can overwrite a newer copy made elsewhere: "Choose a passkey" offers every eligible passkey, including ones that already have a copy. This only gets in the way: the new device then needs keys. It isn't a leak. The server could refuse lower versions. Also, "behind-elsewhere" says "older keys" even when the copy is newer than this device's keys.
- **I9:** confirming with a passkey to set up unlocking also sets `reauth_at`. So it opens the 10-minute window for changing keys and adding passkeys too. That is acceptable, because it is a UV-checked passkey check, but it is worth knowing.

### Verdict

**Sign-off with conditions.** All six conditions from the first review are met, and the new tests and probes support the author's table, apart from the gaps noted above.

Conditions:
1. N1: `'required'` in `/passkey/reauth/options`, with a test that a reauth answer without UV is refused with a clear message. This one also matters with the switch off: `ROTATION` is on in production, so it affects changing keys today.
2. N2: list the new columns in THREAT_MODEL and the privacy policy, and say there that fetches are seen.

When both are done, **`PASSKEY_UNLOCK` can be turned on in production.** A check of those two changes is enough. N3, N4 and I7–I9 are recommended, not required.

## Fixes after the check

| Item | Fix | Test |
|---|---|---|
| N1 | `/auth/passkey/reauth/options` asks for user verification as `required`, matching the verify route. | Reading |
| N2 | THREAT_MODEL lists `passkeys.aaguid`, `sessions.reauth_at`/`passkey_id`, `users.keys_changed_at` and the copy versions; the privacy policy says the server records each passkey's provider, when you last changed keys, and when a device fetches an unlock copy. | — |
| N3 | `/me` returns `keys_changed_at`. After a change of keys, the Passkeys card asks for "I've removed the lost device from my Apple, Google or password manager account…" before adding a passkey or turning unlocking on. | Reading |
| N4 | Fetch emails are no longer capped (fetches are limited to ten an hour), so a second device asking in the same hour is told. | API "tells every fetch, and never lets older keys replace newer ones" |
| I8 | `PUT` refuses (409 `newer_copy`) a copy holding older key versions than the one stored. | Same test |
| I7, I9 | Accepted: unknown providers show as "Passkey N"; a confirmation for unlocking also counts as a recent sign-in for changing keys (both need that passkey and face, fingerprint or passcode). | — |

## Final check (commit ad1ddd4)

- Date: 2026-11-04. Scope: `git show ad1ddd4`, read against "Fixes after the check", which was treated as claims to check.
- Suites at HEAD, all green: `pnpm test:api` (106), `TZ=UTC pnpm test` (691), `e2e:sync` (3). The other browser e2e projects were not run again. No probes were needed this time.

### Items

| Item | Verdict | Notes |
|---|---|---|
| N1 | **Fixed** | `/auth/passkey/reauth/options` now asks for `userVerification: 'required'` (`auth.ts:401`). `confirmItsYou` passes the server's options unchanged, so the browser now asks for face, fingerprint or PIN, or says it can't, instead of the server refusing the answer afterwards. `enablePasskeyUnlock` already asked for `'required'`. There is no test, but it is a one-line change, read and confirmed. |
| N2 | **Fixed** | THREAT_MODEL's table now lists `passkeys.aaguid` (and notes that it is recorded whether or not unlocking is on), `sessions.reauth_at`/`passkey_id`, `users.keys_changed_at` and the copy versions, and says the server sees when a copy is fetched. The privacy policy names the passkey provider, the copy versions and fetch times, and when keys last changed. The wording is accurate. |
| N3 | **Addressed** | `/me` returns `keys_changed_at`. After a change of keys, "Add a passkey" and "Choose a passkey" stay disabled until the person ticks "I've removed the lost device from my Apple, Google or password manager account…". This is the confirmation the check asked for. It is enforced only in the UI, which is enough here: the risk is the person's own mistake, not an attacker's. See F3 for its rough edges. |
| N4 | **Fixed** | Fetch emails now go out on every fetch, with no cap (`keys.ts`). Fetches are still limited to 10 an hour per user, so this is at most 10 emails an hour. API test: two fetches send two emails. The "set" and "off" notices are still capped at one an hour (F4). |
| I8 | **Fixed** | `PUT` refuses with 409 `newer_copy` a copy whose space or personal version is below the stored one. API test. See F2 for one case where the refusal is wrong. |
| I7, I9 | **Accepted** | As recorded in the table. Fine. |

### Follow-ups (none blocking)

**F1 (Low, docs): the "once an hour" wording is out of date.** Fetch emails are no longer capped (N4). But THREAT_MODEL line 100 still says the fetch email is sent "at most once an hour", and ADR 0015 line 16 still says "(at most one of each an hour)". Both now say less than the app does. Reword them: fetches are emailed every time; setting a copy up and turning one off are emailed at most once an hour each.

**F2 (Low): `newer_copy` compares space versions across different spaces.**

- `PUT` compares `space_version` with the stored copy's, but a copy doesn't record which space its version belongs to.
- Someone can leave a space whose key had reached version 3 (`DELETE /spaces/:id/membership`), then create or join another space at version 1. Every new copy for that passkey is then refused with "This passkey already unlocks newer keys", which is wrong. Leaving the old space doesn't delete the copy.
- The way out exists ("Stop unlocking", then turn it on again), but nothing points to it.
- Fix: store the space id with the copy and compare versions only within the same space. Or delete the user's copies when they leave a space. Or, on `newer_copy`, offer "Replace it". Not a security issue.

**F3 (Info): rough edges in the N3 confirmation.**

- The tick is kept only in component state, and it is asked whenever `keys_changed_at` is set. So anyone who ever changed keys must tick it every time they open the card to add a passkey, even years later.
- It is shown, and blocks "Add a passkey", even when `PASSKEY_UNLOCK` is off, where it doesn't apply.
- The "Add a passkey" step in Start's set-up flow isn't covered. That flow is reached again after leaving a space.
- Suggestion: show the tick only while unlocking is on, and only until the first passkey added after the change of keys.

**F4 (Info): the "off" notice is still capped.** Someone with a session token can turn off several copies in one hour, and only the first sends an email. This only removes the one-touch way back; it exposes nothing. THREAT_MODEL already records turning copies off from a session as accepted. It could add that only the first one in an hour is emailed.

### Verdict

**Sign-off.** Every condition from the first review and from the check of the fixes is met. Nothing found in this round puts keys at risk.

**`PASSKEY_UNLOCK` can be turned on in production now** (set `"PASSKEY_UNLOCK": "on"` in the production vars of `apps/api/wrangler.jsonc`, together with a deploy of the matching web build). F1 and F2 should be fixed in the next change. F3 and F4 are at the owner's discretion.

### Follow-ups fixed

- **F1:** THREAT_MODEL and ADR 0015 now say the fetch and "turned off" emails are sent every time; only "turned on" is capped at one an hour.
- **F2:** `PUT /keys/unlock/:id` compares only `personal_version`, which only goes up for a person. A copy made after leaving a space and joining another is no longer refused. The `newer_copy` error now points to "Stop unlocking", then turning it on again. Tested in `unlock.test.ts`.
- **F3:** the "lost device removed" tick is shown only while unlocking is on, and only until a passkey is added after the change of keys. The answer is kept on the device (localStorage, per change of keys), so it isn't asked every time.
- **F4:** the "turned off" email is sent every time.

`PASSKEY_UNLOCK` is on in production.
