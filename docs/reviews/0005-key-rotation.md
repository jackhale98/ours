# Review 0005: key rotation (phase 7, ADR 0013)

- Reviewer: independent agent that did not write the code (build plan §11)
- Date: 2026-11-03
- Scope: commits 6691236 (server and core part) and 4e863fd (client part), checked against ADR 0013, crypto review 0001 (M1, the M2 note on version allocation, I4) and THREAT_MODEL:
  - core: `packages/core/src/crypto/pairing.ts` (`rekey` kind), `keys.ts`, `codec.ts`, `bundle.ts`
  - server: `migrations/0007_key_rotation.sql`, `routes/spaces.ts` (`POST /:id/rotate`), `routes/sync.ts` (push floor), `routes/push.ts` (`requireCurrentKey`), `routes/invites.ts` (`rekey`), `routes/me.ts`
  - client: `apps/web/src/account/session.ts` (`rotateKeys`, `keyUpdateLink`, `applyKeyLink`, `refresh`, `restartSync`), `account/sync.ts`, `app/mount.tsx`, `app/App.tsx` (banner), `app/views/AccountCards.tsx` (`SecureCard`)
  - tests: `apps/api/test/rotation.test.ts`, `pairing.test.ts`, the end of `e2e-sync/pair.spec.ts`
  - Uncommitted changes in the working tree (import, recurrence) were not reviewed.
- Verdict (re-review 2, 2026-11-04): **Sign-off with conditions.** Commits e7bed9a and 9ea66f7 fix N1–N6 in the main. Conditions: fix R1–R3 and the start-up path of L7, with tests. Then turn on `VITE_ROTATION` and `ROTATION` together. Crypto review 0001 M1 is closed. See "Re-review 2" at the end.
- Re-review verdict (2026-11-04): no sign-off. Retrying a rotation that already landed threw the new keys away (N1, High).
- First verdict (2026-11-03): no sign-off. Conditions: fix H1 and H2, and M1–M6, with regression tests. Fix the Lows or record them as accepted risks in THREAT_MODEL.
- Fixes: commit 8693ec3, listed in "Fixes" at the end. Re-reviewed in "Re-review (commits 8693ec3, 199fb4f)"; its fixes in "Re-review 2 (commits e7bed9a, 9ea66f7)".

The reviewer ran the existing suites, all green: `pnpm test:api` (85 tests), `pnpm test` (596) and `e2e:sync` (1, including the rotation part). Seven probe tests ran against the Worker in vitest pool workers from a scratch config outside the repo, and were then deleted. They are referenced as P1–P7 below. Nothing in the repo changed apart from this file.

## Summary

The building blocks are sound. The `rekey` AAD kind is separate from partner and device links. Claiming a link is restricted correctly. The server refuses old-version writes. The +1 version rule serialises rotations on the server. The happy path works end to end: a stale partner's held change is re-sealed and synced, and both people see the same new safety code.

The weak points are on the edges of the flow, and several fail silently and badly:

- A rotation that fails offline leaves **orphan keys** on the device. The device then uses them, because the server accepts any version above the floor. The partner can no longer read that person's new writes, and a later real rotation collides with the orphan version. Key update links silently skip a conflicting version, so nothing repairs it (H1).
- Rotation commits **before** the new recovery backup exists. If the person stops at the phrase step, or the page reloads, their backup holds none of the keys their data is now sealed under (H2).

The rest is about completeness and delivery:

- The rotate batch can half-apply (M1).
- Re-encryption covers only what the rotating device has stored locally. Nothing checks that it finished, and nothing resumes an interrupted rotation (M2).
- A key update link can't be issued again without a whole new rotation (M3).
- Anyone holding a session in the space can mint a key update link that carries any keys. The client accepts them, so a removed device that signs in again can redirect the partner's new data to its own keys (M4).
- The partner's edits made during the stale period can be overwritten when the keys arrive (M5).
- The client's "decrypt-only" check rests entirely on values the server supplies (M6).

**Answers to the questions in scope, in short.**

- *Removed device:* it can't read new writes on the normal path. Exceptions:
  - records never re-encrypted (M2);
  - a write that races the rotation (L1);
  - reminders and held notifications still queued under the old keys (L2);
  - the feed link (L7);
  - a device that signs in again and gets the partner to open its link (M4).
- *Permanent "needs keys" or data loss:* yes, through H1, H2, M1, M3 and L3. A malicious server can also add a needs-keys banner, though that is denial of service only (M6).
- *Rekey link:* it is claimable only by the other member, it is single-use, and it can't serve as a first invite or as a device link. It needs no rotation and its contents aren't checked (M4).
- *`applyKeyLink`:* it refuses device links from another account, and `mergeFrom` refuses conflicting keys. The rekey path, however, *skips* conflicts silently and accepts versions above the server floor (H1, M4).
- *Lying server:* yes in both directions (M6).
- *Skipping the new phrase:* yes, this leads to data loss (H2). The partner's backup is never updated either (M3).
- *Rotate route:* it is members-only and rate-limited (P6). It needs no recent sign-in and sends no notice (M4).

| ID | Severity | Finding | Verified |
|---|---|---|---|
| H1 | High | An unconfirmed rotation leaves orphan keys that the device then writes under (the server accepts versions above the floor). They later collide with the real version, and the rekey link skips the conflict | Test (P3) + reading |
| H2 | High | Rotation commits before the new recovery backup exists. Stopping at the phrase step loses everything re-encrypted if that device is lost | Reading |
| M1 | Medium | `POST /rotate` batch is not all-or-nothing. On a race the loser gets 409, but its personal floor still moves, and the client discards its new keys | Test (P1b) |
| M2 | Medium | Re-encryption covers only what is stored locally on the rotating device. It is never verified, and an interrupted rotation is never resumed | Reading |
| M3 | Medium | Key delivery is one-shot. An expired or used link, the partner's other devices, or the partner's stale backup can only be fixed by another full rotation | Reading |
| M4 | Medium | Key update links are unconstrained. Any member can mint one at any time with any keys, and the client adds any new version. A removed device that signs in again can take over the partner's new writes | Test (P4) + reading |
| M5 | Medium | While stale, `resolve` overwrites the merge base with a record the device can't read. After the keys arrive, the partner's later edits are reverted | Reading |
| M6 | Medium | The client's decrypt-only rule depends only on server-supplied `key_version`, `rotated_rev` and `rev`. Nothing is persisted, and there is no downgrade check | Reading |
| L1 | Low | Push, notify and reminders read the floor before their write (TOCTOU). An old-version write can land after `rotated_rev`, and every client then hides it | Reading |
| L2 | Low | Queued reminders and quiet-hours notifications under old keys survive rotation and are still sent | Test (P5) |
| L3 | Low | A stale device can rotate, which leaves gaps in its ring. Records under a missing version are treated as deleted, and pending edits on them are dropped | Reading |
| L4 | Low | The personal floor is per user, but the rotation point is per space. Multi-space accounts (the API allows 3) are left half-rotated | Reading |
| L5 | Low | A conflict whose current version is under an unknown key makes `push()` spin until 429 | Reading |
| L6 | Low | The banner sends the partner's *other* devices to the single-use link that is already used | Reading |
| L7 | Low | Rotation does not replace the calendar feed link that a removed phone may be subscribed to | Reading |
| I1–I6 | Info | See below | — |

## Verified correct

- **AAD separation:** the `rekey` kind is in the invite AAD (`invite | rekey | space_id`). Partner and rekey links fail to open as each other, or for another space (`pairing.test.ts`). Device links bind the user id.
- **Claiming:** only the other current member can claim a `rekey` link. The creator and outsiders can't (`rotation.test.ts`). A former partner can't claim one after leaving (P7). The first fetch claims it, accepting erases the blob, and it can be used once. Accepting adds no membership, and `GET` requires membership, so a rekey link can't act as a first invite. `applyKeyLink` refuses anything other than `rekey` for this space or `device`. A device link from another account fails twice over: the server claim requires `created_by = uid`, and the AAD carries the user id. `mergeFrom` throws on a conflicting version and is applied to a copy, so nothing is saved if it fails.
- **Server floors:** sync push, `/push/notify` and `/push/reminders` refuse versions below the floor with `stale_key`. The personal floor moves only for the rotating user. `/me` reports the floors.
- **Version allocation (M2 note):** rotation must step exactly +1 from the caller's stated versions, and a second rotation from the same point gets 409 (`rotation.test.ts`). The core `KeyRing` still refuses to re-key an existing version (`setOnce`).
- **Rotate route:** non-members get 404, and the route is limited to 10 per user per day (P6). A single member can rotate after the partner left, and no link is made then (P7).
- **Client happy path (E2E):** the stale partner keeps their data and is shown the banner. A plan they make while stale is held. After they open the link, it is re-sealed and synced. The safety code changes, and both sides match (review 0001, I4).

## Findings

### H1 (High): orphan keys from an unconfirmed rotation are used and later collide

- **Location:** `session.ts` `rotateKeys` l. 496–529 (keeps the new keys when `ApiError.status` is 0); `applyKeyLink` l. 573–575 (`if (!have.has(k.version))`); `routes/sync.ts` l. 105–106 and `routes/push.ts` l. 81 (only `version < floor` is refused).
- **What happens:** `rotateKeys` saves a ring that already holds space key v+1 and personal key v+1, *before* it calls `POST /rotate`. If that call fails with a network error, the keys are kept "for a retry". If the person doesn't retry, the next app start loads that ring. `currentSpaceKey()` and `currentPersonalKey()` are then the unconfirmed v+1 keys, and every new record, notification and reminder is sealed under them. The server accepts this because it refuses only versions *below* the floor. P3 shows that `key_version: 99` is accepted by both `/sync/push` and `/push/notify`. Consequences:
  - The partner's devices can't open any of these records. `unknownKey` sets the banner "Sam changed your shared keys. Open the key update link", but no link exists and the server floor never moved. This person's own device shows nothing wrong.
  - Later the partner rotates and allocates the *real* v+1 under a different key. When this person opens the partner's link, `applyKeyLink` silently skips v+1 because the ring "already has" it. The toast says "New keys added". From then on, every record the partner re-encrypted fails to decrypt with the orphan key. `unknownKey` is false (the version is not newer than the latest), so `resolve` treats each record as gone: it is removed from the UI and its pending local edit is deleted. The reverse also holds: the partner can't read this person's writes. A device link can't repair the ring, because `mergeFrom` throws on the conflict.
  - This is exactly the collision that review 0001 M2 deferred to "collision-safe key ids… in the rotation design". The server's +1 rule serialises *allocation*, but nothing binds a version to a particular key.
  - A related note: the commit message says "a retry after a lost response reuses the keys". That holds only if the request never reached the server. If it landed, `/me` already reports v+1, and the retry rotates again to v+2. This is harmless, but the claim should be corrected.
- **Impact:** an ordinary flaky-network failure on "Make new keys" can silently split the couple. Each side's new writes become unreadable to the other. After the next rotation, records disappear from the UI and pending edits are dropped. There is no recovery path in the app.
- **Fix:**
  1. The server refuses `key_version > floor` on push, notify and reminders: only the current version may be written.
  2. Keep new keys in a separate *staged* slot that is never used for sealing until the server confirms the rotation. On any failure, either discard them, or keep them only for a retry from the same `from` versions. On the next start, drop staged keys that `/me` doesn't confirm.
  3. Bind a key id into the version, e.g. `kid = H(label | space_id | version | key)`. Send it with `POST /rotate`, store it on the server, and return it from `/me`. A retry or a link can then tell whether *its* key won. Put the kid in the record AAD as review 0001 M2 intended.
  4. `applyKeyLink` must refuse (not skip) a payload whose key for an existing version differs, and offer a way to drop unconfirmed versions.
- Regression tests: the server refuses `floor + 1`; the client never seals under an unconfirmed version; a link with a conflicting version is refused.

### H2 (High): rotation commits before the new recovery backup exists

- **Location:** `rotateKeys` (server floors raised, everything re-encrypted, link made); `SecureCard` l. 308–420 (the new phrase is generated *after* rotation, and the stage lives only in component state); `saveBackup`.
- **What happens:** after `POST /rotate` and `reencryptAll`, all live records are sealed under keys that exist only on this device. The server backup is still the old one (old phrase, old keys). The new phrase is shown afterwards, and saving it is a separate button. Several ordinary things leave the backup stale for good, with no reminder anywhere:
  - closing the tab;
  - navigating away;
  - a reload;
  - `saveBackup` failing (e.g. offline).

  The `stage` and `words` are lost with the component. If this device is then lost or wiped (the person has just lost a phone, so it may be their last device), restoring from the old phrase gives only the old keys:
  - **Every personal record is unrecoverable.** It is under personal v+1, and no other device or person has that key.
  - **If there is no partner, or the partner hasn't opened the link yet, every space record is unrecoverable too.**

  The restored device shows "ready" with an almost empty planner and a banner pointing to a device link from "another device".
- **Impact:** permanent data loss after an interrupted, but otherwise successful, security action.
- **Fix:** make the backup part of the commit, before the server moves:
  1. Generate the new ring and the new phrase.
  2. Show the phrase and require confirmation (e.g. re-enter two words).
  3. `PUT /keys/backup` sealed with the new phrase over the *new* ring. That ring holds the old keys too, so it is safe even if step 4 never happens.
  4. Only then call `POST /rotate`.

  Also persist a "rotation incomplete" marker until backup, re-encryption and link are all done (see M2), and show a blocking banner while it is set. Test: abort after `/rotate`, then restore from the phrase; the data must open.

### M1 (Medium): the rotate batch can half-apply

- **Location:** `routes/spaces.ts` l. 53–71.
- **What happens:** the pre-check and the two conditional `UPDATE`s are separate steps, and a D1 batch does not roll back an `UPDATE` that matched 0 rows. When the partner rotates between this request's pre-check and its batch, the space update changes nothing, but the caller's personal update succeeds. The response is still 409. P1b replays the batch exactly as the route runs it after Sam's rotation: `changes 0 1`, and Alex's `personal_key_version` is now 2. Alex's client sees 409 and restores the old ring (`err.status >= 400`), discarding personal v2. Alex's personal floor is now 2 with no key anywhere:
  - every private change is held with `stale_key`;
  - the banner says to link from "another of your devices", which also lack it;
  - only rotating again (which needs a new phrase and relinking every device) recovers.

  Two concurrent `Promise.all` rotations (P1) were serialised by miniflare and did not hit the window. On D1 the window is real.
- **Fix:** make the batch atomic. For example, put both conditions in one guard that aborts the batch (`INSERT INTO quota_guard SELECT NULL WHERE NOT (…both versions match…)` first, as the quota check does). Or make the second `UPDATE` conditional on the first having happened, e.g. `WHERE … AND (SELECT key_version FROM spaces WHERE id=?) = ?from + 1`. Add a test that simulates the interleaving.

### M2 (Medium): re-encryption is local, unverified, and not resumable

- **Location:** `rotateKeys` l. 527–528; `SyncEngine.reencryptAll` l. 247; `start()` l. 195 (`void this.sync()`).
- **What happens:**
  - `reencryptAll` re-seals what is in *this device's* `envelopes` store when it runs. `restartSync` does not wait for the new engine's first pull, so records the device hasn't pulled yet are never re-encrypted. That covers a device that was asleep or offline, or the partner's writes from just before the rotation. Their later arrival creates nothing to re-seal.
  - Records the device can't decode are skipped silently, for example a newer schema from the partner's newer app, or the L1 race. They stay under the old key indefinitely.
  - No other device ever re-encrypts. The partner's devices re-seal only their outbox.
  - Nothing counts what is left.
  - If the app is closed, crashes or loses the response after `POST /rotate` but before `reencryptAll` and `keyUpdateLink`, nothing resumes. The person's device looks normal, every old record stays under the old key, and the partner never gets a link (see M3).
- **Impact:** records written before the rotation stay readable by the removed device with a later database copy, which is the case ADR 0013 promises to close for "every live record". The partner can be left needing keys with no link in existence.
- **Fix:**
  1. Before rotating, run a complete pull (`await sync()` until `more` is false and the outbox is empty) and refuse to start on error.
  2. After rotating, re-encrypt, pull again, and repeat until nothing below the current version remains.
  3. Expose the count of live records below the floor (`GET /spaces/:id/rotation` → `{ space_below, mine_below }`), and keep a "finish securing" banner until it is 0.
  4. Have *every* device that holds the current keys sweep its local envelopes below the latest version on start.
  5. Persist rotation progress (`rotating: { from, stage }`) in IndexedDB and resume it on start.

### M3 (Medium): key delivery is one-shot and can only be repeated by rotating again

- **Location:** `keyUpdateLink` is called only from `rotateKeys` and from no UI; `SecureCard` keeps the link only in component state; invites expire after 24 h and are single-use.
- **What happens:** the partner can't get the new space key, except by another full rotation, when:
  - the link expires;
  - the card is left before it is shared;
  - the link is opened on one of the partner's devices, so it is used up and the others still need keys (L6);
  - the partner later restores from their recovery phrase.

  That last case matters most. `applyKeyLink` adds the new space key to the partner's ring, but the partner's server backup is sealed with *their* phrase, which no device holds, so the backup can never gain the new key. The UI only says "compare your safety code". The partner's phrase now silently fails to restore the shared space.
- **Fix:**
  - Offer "Send key update link" in Privacy whenever the partner hasn't confirmed the current version. The server can track the version each member last wrote under, or an explicit acknowledgement, and the link can be regenerated without rotating.
  - After `applyKeyLink`, prompt the partner to make a new recovery phrase (with the same persistent banner as H2).
  - Mention in the banner that a device which already has the keys can link this one (L6).

### M4 (Medium): key update links are unconstrained, so a removed device that signs in again can redirect the partner's data

- **Location:** `routes/invites.ts` l. 81–90 (any member, any time); `applyKeyLink` l. 573–575; `routes/spaces.ts` `rotate` (no recent-auth check, no notice); `routes/me.ts` `DELETE /devices/:id` (passkeys and email are untouched).
- **What happens:** removing a device ends its sessions, but it can sign in again with a passkey stored on it or with the email app on it. With a session it can:
  1. mint a `rekey` link with keys of its choice. No rotation or floor check is needed: in P4 Alex made one with nothing rotated, and Sam claimed it.
  2. send the link to the partner from the stolen phone's own messaging apps ("the app asked me to send you this").

  `applyKeyLink` adds any version the ring doesn't have, including versions above the server floor. The partner's device then seals everything new under the attacker's key (accepted, see H1), and the attacker pulls it with its session. The real owner's devices can't read those writes and show a banner.

  Other things the regained session allows:
  - It can call `POST /rotate` with no re-authentication, pushing every real device into "needs keys" (denial of service).
  - If the owner's chats sync to the stolen device, it can claim the owner's new *device* link first.

  A malicious server could deliver such a link by email, but it can't see the real link's secret. The safety-code comparison is the only check, and it happens after the device has started writing under the new key.
- **Impact:** defeats the purpose of rotation (keeping the removed device out of new data) through a plausible social-engineering path.
- **Fix:**
  - The server accepts a `rekey` invite only from the member who made the latest rotation, only shortly after it, and only for the current version (store `rotated_by` and `rotated_at`). It refuses `key_version > floor` (H1).
  - `applyKeyLink` accepts only when this device actually needs keys. The payload's newest version must equal the server floor, and every old version must match the ring. Show the new safety code *before* applying, with an explicit "I compared it with <name>" step.
  - Require a recent sign-in for `/rotate` (as for adding a passkey) and email both members when keys change.
  - Make "Secure your space" also list passkeys for removal and warn that a removed device that can still sign in (passkey or email on it) is not shut out.
  - Document the residual risk in THREAT_MODEL.

### M5 (Medium): edits made by the other side during the stale period are lost when the keys arrive

- **Location:** `sync.ts` `resolve` l. 370–376 (`d.put('envelopes', remoteEnv)` before the unknown-key early return).
- **What happens:** while the partner's device lacks the new key, each pulled record it can't read *replaces* the stored base envelope. The device keeps its old view and holds its own edits. After the keys arrive, its held edit conflicts. `resolve` then merges with `base = remote` (the latest server version), so `mergeFields` treats every field where the local copy still has the *old* value as a local change. The rotator's post-rotation edits to those fields are reverted. A shared list edited by both people during the stale period (possibly days) loses the rotator's changes silently.
- **Fix:** don't overwrite the base when the remote can't be opened. Keep it (or store the unreadable remote separately) and re-pull from the old cursor once keys arrive, so that the three-way merge uses the true base. Test: Sam edits field A after rotation, stale Alex edits field B, then Alex applies the link; both edits survive.

### M6 (Medium): the client's decrypt-only rule trusts the server completely

- **Location:** `refresh` l. 145–153 (floor taken fresh from `/me`, not persisted); `SyncEngine.open` l. 112–120.
- **What happens:** the check "old version and `rev > rotated_rev`" uses `key_version` and `rotated_rev` from `/me`, and `rev` from the same server. A server holding an old key (with a removed device's keys, or a database copy plus the old key) can still serve forged or rolled-back records under the old version:
  - it can report `rotated_rev` as 0 or `key_version` as 1;
  - it can simply give the forged record a `rev` at or below `rotated_rev`;
  - it can replace a record this device already holds under v+1 with an older-version copy.

  ADR 0013 says "clients additionally refuse old-version writes newer than their own last-seen rotation", but this is not implemented. In the other direction, a server can report a high floor to hide valid data or show a needs-keys banner, which is denial of service and can also be used for social engineering (M4).
- **Fix:**
  - Persist per space a monotonic `{ version, rotated_rev, cursor_at_learn }` and never accept a lower value from `/me`.
  - Refuse a remote envelope whose `key_version` is lower than the one stored locally for the same id (a downgrade).
  - Refuse old-version records whose rev is above the cursor at which this device first held the new version.
  - Update the ADR and THREAT_MODEL to say what a fresh device can't check.

### L1 (Low): floor checks are not atomic with the writes

- **Location:** `routes/sync.ts` l. 84–90 vs l. 210; `routes/push.ts` `requireCurrentKey` (read, then insert).
- **What happens:** a push that read `floor = 1` can commit after a rotation and get `rev > rotated_rev` under v1. Every client then refuses it: on the rotator, `resolve` removes the record and deletes any pending edit for it. On the writer, it disappears at the next restart. Nobody can re-encrypt it. Notifications and reminders have the same race (sent or stored under the old key). Probe P2 (20 pushes racing a rotation, eight times) did not interleave in miniflare.
- **Fix:** enforce the floor inside the batch, e.g. `… WHERE excluded.key_version >= (SELECT key_version FROM spaces WHERE id = ?2)` (and the personal floor for user scope) on the upsert, plus a guard that aborts. Map an abort to `stale_key`.

### L2 (Low): queued notifications under old keys survive rotation

- **Location:** `routes/spaces.ts` rotate; `push/send.ts` `sendDue`; `notify.ts` `syncReminders` (`reminders-sig` is unchanged by rotation).
- **What happens:** P5 shows that after rotation, the reminder stored under personal v1 (title, time, place) is still in `reminders`. It is re-sealed only when the person's planned reminders change, up to 8 days later. Quiet-hours notifications under the old space key also stay queued. `sendDue` doesn't check floors.
- **Fix:** in the rotate batch, delete `reminders` rows of the caller's `kind = 'reminder'` (user scope) and the space's `deferred` rows below the new versions (or let `sendDue` skip them). Reset `reminders-sig` on the client after rotation so that the reminders are re-uploaded at once.

### L3 (Low): a stale device can rotate, which leaves gaps in its ring

- **Location:** `SecureCard` (shown even while `needsNewKeys`); `SyncEngine.unknownKey` (`version > latest`).
- **What happens:** if Sam rotated to v2 and Alex presses "Make new keys" before opening Sam's link, Alex allocates v3 and holds {v1, v3}. Alex's `reencryptAll` can't re-encrypt Sam's v2 records. Alex's link lacks v2. On Alex's device, every v2 record counts as "not unknown" (2 < 3), so `resolve` removes it and deletes any pending edit for it. The same happens with any ring gap.
- **Fix:** disable rotation while `needsNewKeys` (or require applying the pending link first). Define `unknownKey` as "the ring has no key for this version", and keep local data in that case.

### L4 (Low): personal-key floor and rotation point don't match for multi-space accounts

- **Location:** migration 0007 (`users.personal_key_version`, but `spaces.rotated_rev`); `reencryptAll` (this space only).
- **What happens:** the API allows up to 3 spaces per user. Rotating one space raises the personal floor everywhere, but re-encrypts personal records only in this space and leaves the other spaces' keys unrotated. The client's personal floor check uses the *space's* `rotated_rev`, which also moves when the partner rotates. The client uses `spaces[0]` only, so this is latent today.
- **Fix:** store `personal_rotated_rev` per user (or per user and space), and either rotate all of a user's spaces together or document single-space as an invariant enforced by the API.

### L5 (Low): push loop spins on an unknown-key conflict

- **Location:** `sync.ts` `push()` loop with `resolve` l. 371–375.
- **What happens:** when a pushed record conflicts and the current version is under a version this device doesn't have, `resolve` returns without touching the outbox and without setting `stale`. The `for (;;)` loop then re-sends the same batch immediately until the rate limit returns 429. This is reachable through H1 (a version above the floor) or a lying server.
- **Fix:** in the unknown-key branch, mark the item as held (as for `stale_key`) and leave the loop.

### L6 (Low): misleading banner for the partner's other devices

- **Location:** `App.tsx` `NewKeysBanner`; `newKeysFrom()`.
- **What happens:** when the partner's phone has used the single-use link, their tablet still says "Open the key update link they sent you", which no longer works. The way that does work, a device link from the phone, isn't mentioned.
- **Fix:** add "or link this device from your other device that already has the new keys". See also M3.

### L7 (Low): rotation leaves the calendar feed link alone

- **Location:** `SecureCard`; `routes/feed.ts`.
- **What happens:** a removed phone whose calendar app subscribed to the busy feed keeps receiving busy times. These are plaintext by design and not key-protected. The "Secure your space" step does not offer "new feed link".
- **Fix:** offer it in the flow, or replace the feed link automatically when it is on.

### Info

- **I1:** `applyKeyLink` fetches (and so claims) any pending link before checking its kind. A set-up user who opens someone else's first-invite link burns it. Check `kind` from a cheap metadata call, or claim only for `rekey`/`device`.
- **I2:** an unused rekey blob stays on the server for up to 24 h. Someone who sees the link in synced chat history and has a database copy could open it. Recommend sharing in person (QR), and make sure expired invites are purged.
- **I3:** the safety-code re-comparison (review 0001, I4) is prompted only by a toast. Keep a "not yet compared since keys changed" state in Privacy until confirmed.
- **I4:** a new partner who joins after the old one left receives every old space key version. They can read history in D1 Time Travel copies. This is a design note for ADR 0013.
- **I5:** `rotate` counts failed (409) attempts against its 10 per day (P6). A client retrying a conflict can lock the person out of rotating for a day. Count only successes, or allow a higher limit for 409s.
- **I6:** tests don't cover the interleaved rotate batch, the floor TOCTOU, versions above the floor, the network-failure path in `rotateKeys`, re-encryption completeness, merges during the stale period, ring gaps, or rekey links with conflicting or higher versions.

## Sign-off

No sign-off until H1, H2 and M1–M6 are fixed with regression tests. Fix L1–L7 or record them as accepted risks in THREAT_MODEL, and correct ADR 0013's "last-seen rotation" claim to match the implementation. The Info items are at the owner's discretion. Crypto review 0001 M1 stays **open** until then.

## Fixes (commit 8693ec3)

Tests: `apps/api/test/rotation.test.ts` (server), `apps/web/src/account/rotation.test.ts` (key checks), `packages/core/src/crypto/safety.test.ts` (fingerprints), and the rotation part of `apps/web/e2e-sync/pair.spec.ts` (two browsers, end to end).

| ID | Fix | Test |
|---|---|---|
| H1 | (1) Push, notify and reminders accept only `key_version == floor` (`unknown_key` / `stale_key`). (2) New keys are staged in a separate wrapped slot and never sealed under; the ring gains them only when `POST /rotate` succeeds, or when `/me` shows the rotation landed (fingerprints match) after a lost answer. Staged keys are dropped if the versions moved without them or no backup was made. (3) Each rotation stores `kid = SHA-256(AAD('ours/key-id/v1', scope, owner, version) ‖ key)[0..16]` per new key in `key_ids`; `/me` returns them. On every start a device drops keys above its floor and doesn't use a key whose kid differs. Not done: the kid is not in the record AAD (format change); the exact-version rule and the checks make it unnecessary for the collision described. (4) Links: `takeKeys` refuses a conflicting key for a held version, except that a held key whose kid doesn't match is replaced by one that does. | API "refuses writes under a version newer…", "records key fingerprints…"; web "drops keys above the floor", "sets aside a key whose fingerprint differs", "refuses a conflicting key…", "replaces this device's orphan key…" |
| H2 | `prepareRotation` (after a full sync) stages keys and makes the phrase; `commitRotation` checks two words, saves the backup over old + staged keys, then calls `/rotate`. The stage (`staged` with `backup`, then `securing`) is kept in IndexedDB; a banner offers "Try again" for a rotation the server didn't confirm, and re-encryption resumes on start. Restoring from the new phrase after an abort gives a ring whose staged keys are dropped at start if the rotation never happened. | E2E (phrase, two words, then rotation); reading |
| M1 | `rotateStatements` is one batch led by a `quota_guard` insert that aborts it unless both versions are still the expected ones. | API "rolls the whole rotation back when the partner rotated in between" (replays the batch after the partner's rotation) |
| M2 | Before rotating: `engine.settle()` (caught up, outbox empty) or refuse. After: re-encrypt, settle, `GET /spaces/:id/rotation` → `{space_below, mine_below}`, up to five rounds, resumed on every start while the stage is `securing`, with a banner showing what's left. Every device holding the current keys sweeps its stored records below them once caught up. | API "counts what is still under old keys…"; E2E (banner clears) |
| M3 | "Make key update link" is shown to the rotator whenever the partner hasn't confirmed the current version (`memberships.key_version`, set by `POST /spaces/:id/keys-ack` with a matching kid, sent automatically by a device that holds it). After using a link the partner sees "Make a new phrase" until they save a new backup. The banner mentions linking from another device (L6). | API "…takes acknowledgements"; E2E (link offered, then gone after the partner has the keys; phrase prompt) |
| M4 | Server: rekey invites only from `spaces.rotated_by`, within 14 days of `rotated_at`, for the current version (stored on the invite; a stale one can't be claimed). `/rotate` needs a sign-in or in-session passkey check (`POST /auth/passkey/reauth/*`) in the last 10 minutes when the account has a passkey, and emails both members. Client: a link is used only when this device needs the current keys, its newest version equals the floor and the kids match; the new safety code is shown with "They match, use these keys" before anything is applied. "Secure your space" warns about passkeys and email left on the lost device. Residual risk in THREAT_MODEL. | API "only the rotator sends key update links…", "needs a recent passkey check…", "emails both members…"; web "refuses keys the server doesn't know", "refuses a link above or below the current version, or when nothing is needed"; E2E (code compared before use) |
| M5 | `resolve` no longer stores a remote envelope it can't open for want of a key: the stored base stays, and the pull records where such records began (`repull:`); the next engine start re-pulls from there, so the merge is three-way against the true base. | E2E: Sam renames a shared item after rotating, stale Alex sets its due date, both survive on both sides (fails without the fix) |
| M6 | The floor is kept per space in IndexedDB and merged monotonically (`mergeFloor`); `rotated_rev` is pinned per version the first time it is learned (from the device's own rotation, or `/me`). A remote copy under a lower key version than the stored one is refused. The suggested "cursor when the key was first held" bound was tried and dropped: a device that is behind would hide legitimate pre-rotation records (it broke the M5 merge in the E2E). ADR 0013 and THREAT_MODEL now describe what a fresh device can't check. | web "never goes down, and pins the rotation point of a version"; reading |
| L1 | The push batch's guard also aborts if either floor moved since it was read (503 `keys_changed`, retried); deferred notifications and reminders are inserted behind a guard on their key version (409 `stale_key`). Immediate sends can't be made atomic with delivery: accepted (a rotation landing mid-request sends one notification under the old key to the partner's current devices). | Reading |
| L2 | The rotate batch deletes the rotator's `reminder` rows and the space's `deferred` rows; the client resets its reminders signature so they are uploaded again under the new key. | API "drops reminders and held notifications under the old keys" |
| L3 | Rotation is refused while the device lacks the current keys. `unknownKey` means "the ring has no key for this version", so a gap keeps local data. | Reading |
| L4 | `/rotate` refuses accounts in more than one space (`multi_space`). | API "refuses rotation for an account in more than one space" |
| L5 | A conflict whose current copy is under an unknown key marks the push as held and leaves the loop. | Reading |
| L6 | Banner: "…or a device link from your other device that already has the new keys." | E2E text |
| L7 | When the feed is on, rotating replaces its link and says so. | Reading |
| I1 | `GET /invites/:id/kind` answers without claiming; a set-up device refuses a partner invite before claiming it. | API (rekey test) |
| I2 | Expired and used invites are already purged hourly; the link screen recommends sharing in person. | — |
| I3 | Privacy keeps "Compare your safety code… / We compared, they match" until confirmed for the current version. | Reading |
| I4 | Documented in THREAT_MODEL. | — |
| I5 | Stale requests are refused before the rate limit counts them. | API "doesn't count refused attempts…" |
| I6 | See the tests above. | — |

Also fixed while testing: the push route's idempotent-retry check ignored `key_version`, so re-sending the same bytes under a new version was reported as written without being written.

## Re-review (commits 8693ec3, 199fb4f)

- Reviewer: independent agent that wrote neither the code nor the fixes.
- Date: 2026-11-04
- Scope: `git show 8693ec3` (code) and `git show 199fb4f` (docs), against the findings above, ADR 0013 and THREAT_MODEL. The "Fixes" table was treated as claims to check.
- Suites, all green at HEAD: `pnpm test:api` (100 tests), `TZ=UTC pnpm test` (657), `e2e:sync` (2, including the rotation part).
- One throwaway API probe (called R1 below) ran and was deleted. It confirmed: `GET /spaces/:id/rotation` and `POST /spaces/:id/keys-ack` answer 404 to non-members; sending the same `POST /rotate` again after it landed gets 409 `rotation_conflict`; `GET /invites/:id/kind` on a rekey link answers 404 to its creator and to outsiders; `keys-ack` accepts the fingerprint copied from `/me`, so it doesn't prove the caller holds the key.
- Client paths in `session.ts` have no unit tests. The client findings below come from reading.
- Line numbers are at HEAD (199fb4f). During this review, others left uncommitted review 0004 work in the working tree (`session.ts`, `sync.ts`, `feeds.ts`, `export.ts`, `recurrence.ts`, THREAT_MODEL, review 0004). It doesn't touch the rotation paths and was not reviewed here, but it shifts some lines. Its `caughtUp` change answers the import side effect noted under M5.
- Nothing in the repo changed apart from this file.

### Original findings

| ID | Verdict | Evidence |
|---|---|---|
| H1 | **Partly fixed** | The server takes only the current version: `sync.ts:109`, `push.ts:86`, and the guards at `sync.ts:190`, `push.ts:240`, `:307`. New keys wait in a separate `staged` slot (`keystore.ts`, `prepareRotation` `session.ts:697-715`). They join the ring only on success or when `/me` fingerprints match (`settleStaged` `:607-631`). Fingerprints are stored in one batch (`spaces.ts:87-91`) and returned by `/me`. `dropUnconfirmed`, `activeRing` and `takeKeys` (`rotation.ts:56-181`) do what the fix says. Tests: API "refuses writes under a version newer…", "records key fingerprints…"; web `rotation.test.ts`. **Gap:** the claim "a lost answer is picked up from /me" holds only on the "Try again" path. The form's own button, and two retries at once, drop the keys on 409 (N1). The fingerprint is not in the record AAD (accepted by the author; see N5 for what that leaves). |
| H2 | **Fixed** | `commitRotation` saves the backup over old and staged keys before `sendRotation` (`session.ts:729-735`). Staged keys with no backup are dropped at start (`:627-630`). The stage is kept in IndexedDB. `RotationBanner` offers "Try again" (`App.tsx:261-295`). E2E covers the happy path. **No test** for the case asked for: abort after `/rotate`, restore from the new phrase, data opens. The new phrase can become the only working one without the person being told (N4). |
| M1 | **Fixed** | One batch led by a guard row on both versions (`spaces.ts:72-103`). Test "rolls the whole rotation back…" replays the interleaving: personal version and fingerprints unchanged. |
| M2 | **Fixed** | `settle()` before rotating (`session.ts:702`). `finishSecuring` re-encrypts, settles and asks `GET /rotation`, five rounds, resumed at start (`:800-826`, `:224`). Every device with current keys sweeps (`sync.ts:223`, `:231`). Test "counts what is still under old keys…"; E2E (banner clears). Edge cases in N2 and Info (stuck "securing"). |
| M3 | **Fixed** | The link can be made again until the partner confirms (`partnerNeedsKeyLink` `session.ts:828-838`, `invites.ts:106-115`). Devices acknowledge automatically (`acknowledgeKeys`). The partner is asked for a new phrase (`session.ts:960`, `PhraseBanner`). API test; E2E (link offered, then gone; phrase prompt). |
| M4 | **Fixed, residual accepted** | Server: rotator only, current version, 14 days (`invites.ts:106-115`); a stale link can't be claimed (`:153`). Recent passkey check when there is a passkey (`spaces.ts:142-147`, `auth.ts` reauth routes). Both members emailed. Client: code shown before use (`KeyLinkPrompt`). Residual in THREAT_MODEL. API tests for each. The THREAT_MODEL sentence on what a malicious server can't do is too strong (N5). |
| M5 | **Fixed** | `resolve` no longer stores an envelope it can't open for want of a key (`sync.ts:431-440`). The pull records where it began (`:485`) and the next start re-pulls from there (`:180`). E2E: both edits to the shared item survive. Side effect on import: see review 0004 re-review, its N6. |
| M6 | **Fixed, residual accepted** | `mergeFloor` never goes down and pins `rotated_rev` per version (`rotation.ts:34-45`); the floor is stored (`learnFloor`). A lower key version than the stored copy is refused (`sync.ts:430`). Web test "never goes down…". THREAT_MODEL describes the fresh-device gap. It doesn't say that someone holding an old key, working with the server, can still add new records that look older than the rotation (Info). |
| L1 | **Partly fixed** | Push batch guard aborts on a moved floor and answers 503 `keys_changed` (`sync.ts:190`, `:226-233`). Deferred notifications and reminders sit behind a version guard (`push.ts:240`, `:307`). No test (reading). The author accepts the race for immediate notifications, but THREAT_MODEL doesn't record it, which the first sign-off asked for. |
| L2 | **Fixed** | The rotate batch deletes the rotator's reminders and the space's held notifications (`spaces.ts:97-102`). The client resets the reminders signature (`commitStaged`). Test "drops reminders and held notifications…". |
| L3 | **Partly fixed** | `unknownKey` now means "no key for this version" (`sync.ts:120-125`), so gaps keep data. `rotationBlocked` refuses while `needsNewKeys`. But the check runs before `settle()` and the fresh `/me`, so an app left open can still rotate from a version it lacks (N3). |
| L4 | **Fixed** | `multi_space` refusal (`spaces.ts:140-141`). Test. The personal rotation point is still the space's (Info). |
| L5 | **Fixed** | A held conflict sets `stale` and leaves the loop (`sync.ts:395`). The new downgrade branch in `resolve` returns `false` without touching the outbox, so a conflict whose current copy is a downgrade is sent again until 429. Only a lying server can cause that (Info). |
| L6 | **Fixed** | Banner text (`App.tsx:193`). E2E. |
| L7 | **Partly fixed** | The feed link is replaced only when `/rotate` answers (`session.ts:789`). A rotation confirmed later from `/me` (`settleStaged`) doesn't replace it. |
| I1 | **Fixed** | `GET /invites/:id/kind` doesn't claim and answers only an account that could claim (`invites.ts:190-211`). It returns only what `GET` would return to that account. API test; probe R1. |
| I2 | **Fixed** | Hourly purge (`app.ts:120`). The card says to share in person or in a private chat. |
| I3 | **Fixed** | Compare prompt until marked for the current version (`AccountCards.tsx` `toCompare`, `markCompared`). Reading. |
| I4 | **Accepted** | In THREAT_MODEL. |
| I5 | **Fixed** | Version check before the rate limit (`spaces.ts:149-150`). Test. |
| I6 | **Partly fixed** | Good server tests now. On the client, only the pure helpers in `rotation.ts` are tested. Nothing tests `sendRotation`, `commitRotation`, `settleStaged`, `resolve` under held keys, the L1 interleave, L3 or L5. N1 would have been caught by such a test. |

The extra fix (idempotent push retry now compares `key_version`, `sync.ts:137`) is correct.

### New findings

**N1 (High): retrying a rotation that already landed throws the new keys away.**
- Location: `session.ts` `sendRotation` catch (l. 777-781); `commitRotation` (l. 722-736); `SecureCard` `commit` (`AccountCards.tsx:395`); `RotationBanner` "Try again" (`App.tsx:271`, no busy guard).
- What happens: Sam presses "Save and use the new keys". The server rotates, but the answer is lost ("You seem to be offline", or a 500 from the queries that run after the batch). The stage stays `staged`, so the form stays on screen. Sam presses the same button again. `commitRotation` skips the backup and calls `sendRotation` at once, without checking `/me`. The server answers 409 `rotation_conflict`, because the versions already moved (probe R1). On any 409 the client drops the staged keys and clears the stage. The same happens when "Try again" is pressed twice and the first call's answer is lost.
- Result: the server's current keys now exist only in the new backup. Sam's device sees it lacks them and says to link from "another of your devices", which doesn't exist. Sam can't make a key update link: it would carry the old version, and the server refuses it. Alex needs the keys too. Neither person can write until Sam signs out (which wipes unsynced edits) and restores from the new phrase. The last toast said "Keys changed on another device. Try again", so Sam may think that phrase is void. Without it, the space stays read-only for both, because rotating again needs the current keys.
- Fix: on 409, fetch `/me` and run the `settleStaged` check. Drop the staged keys only if the server's fingerprint for `spaceFrom + 1` differs from the staged key's. When `st.backup` is already true, have `commitRotation` go through `retryRotation`. Disable both buttons while a call runs. Test with a mocked API: `/rotate` lands but the answer is lost, then 409 on the retry; the keys must join the ring.

**N2 (Low): "Try again" that finds the rotation landed keeps the old sync engine.**
- Location: `retryRotation` → `refresh` → `settleStaged` → `commitStaged`; `refresh` builds an engine only `if (!engine)` (`session.ts:186`).
- What happens: the ring and floor are updated, but the running engine and notifications keep the old ring until the app restarts. New writes are sealed under the old version and held. A "Sam changed your shared keys" banner shows on the rotator's own device. Re-encryption makes no progress. Reminders re-sent under the old key are refused. The feed link is not replaced (L7).
- Fix: call `restartSync` when `settleStaged` commits while an engine is running.

**N3 (Low): the L3 block can be bypassed by an app left open.**
- Location: `prepareRotation` (`session.ts:697-715`).
- What happens: `rotationBlocked()` runs before `settle()` and before the fresh `/me`. A device started before the partner's rotation has `needsNewKeys` false. `prepareRotation` then reads the new versions from `/me` and rotates from a version it doesn't hold. Its ring has a gap. The partner's records under the missing version stay unreadable to it until the partner opens its link and sweeps. Its "securing" stage can't finish before then.
- Fix: after `settle()` and the fresh `/me`, run `activeRing` again. Refuse unless both keys are `ok` for the versions being rotated from.

**N4 (Low): the new phrase can become the only working one without the person being told.**
- Location: `sendRotation` 409 branch; `settleStaged` drop when `!st.backup`; `commitRotation` (backup flag set after the PUT returns).
- What happens: once the new backup is saved, the old phrase no longer opens it. If the rotation then ends without the server confirming (409 from a partner's rotation, or a reload after the backup's answer was lost), the staged keys are dropped and the card returns to "Make new keys". The toast says "Try again". `phraseStale` is not set. A person who throws the new phrase away has no working recovery phrase.
- Fix: mark "backup attempted" before the PUT. When staged keys are dropped after that, say that the new phrase is now the recovery phrase, or set `phraseStale` so the "make a new phrase" banner appears.

**N5 (Low, docs and design): fingerprints come from the server, so they don't bind a malicious server.**
- Location: THREAT_MODEL (key rotation, third residual); `activeRing` and `takeKeys` (`rotation.ts:89`, `:140`, `:147`); `mount.tsx:42`.
- What happens: THREAT_MODEL says a malicious server "cannot get a device to use keys whose fingerprint it didn't record from a real rotation". But the server can record or return any fingerprint, or none. With none, `activeRing` and `takeKeys` accept a key unchecked. So against a server working with someone who holds the old keys, the safety-code step is the only check. That step is shown for key update links only. Device links are applied at once (`mount.tsx:42`), and any of the person's sessions can make one, including a removed device that signs in again. Also, `takeKeys` deletes a held key the server calls an orphan (`drop`, `rotation.ts:147`), so a lying server plus a skipped comparison removes the real key from disk.
- With an honest server, the fingerprints work as intended. The removed device can't forge one (128-bit hash).
- Fix: reword THREAT_MODEL. Show the safety code for a device link that changes the current space key, too. Keep a replaced key on disk, set aside, instead of deleting it.

**N6 (Low, existed before the fixes): a record that won't open is treated as deleted, and its unsynced edit is dropped.**
- Location: `resolve`, the `!remote` branch (`sync.ts:442-446`).
- What happens: if a remote copy can't be opened with a key the device holds, the device replaces its base, deletes the pending edit and hides the record. A server with no keys can trigger this: it can send garbage ciphertext, or raise the `rev` of an old-version envelope past the rotation point, so the decrypt-only rule refuses it (`sync.ts:140`). That destroys unsynced edits, which is more than denial of service. An honest trigger also exists: a record in a newer format from the partner's newer app.
- Fix: hold such a record, as for an unknown key (keep the base and the pending edit, mark it held), unless it opens as a valid deletion.

### Info

- **Stuck "securing".** If a live record under an old key can't be re-sealed by any device holding the current keys, the stage never ends. Examples: a newer format than the rotator's app reads, a corrupt record, or a record a server keeps putting back. While it lasts, `rotationBlocked` refuses a new rotation, even after another lost phone. Consider allowing a new rotation after some rounds, and saying what is stuck.
- **Backdating (M6).** Someone holding an old key, working with the server, can still add new record ids with a `rev` at or below the rotation point. Devices accept them. Personal records use the space's rotation point, which the partner's later rotation moves forward (L4). THREAT_MODEL should say this.
- **`keys-ack`** is not proof of holding the key: the fingerprint is in `/me` (probe R1). It only decides whether the rotator is offered a link. Fine as a hint.
- **UI flag only.** `VITE_ROTATION` hides the card, but the routes and the link-receiving side are live. A removed device that signs in again can rotate today and lock the couple out of writing. Consider a server-side switch until sign-off.
- **`/rotation`** has no rate limit and counts all of a space's records. Pull has none either, so this is consistent.

### Verdict

**No sign-off.**

Blocking:
- N1. It brings back the failure H1 was about: an ordinary lost answer, then the obvious retry, leaves both people unable to write, with no recovery in the app. Fix it and add the client test described.

Before turning on `VITE_ROTATION`, also:
- Fix N2, N3 and N4, or record them in THREAT_MODEL as accepted.
- Correct THREAT_MODEL for N5, and record the immediate-notification race (L1) and the backdating note (Info).
- Fix N6, or record it. It existed before this feature but rotation makes it easier to reach.
- Replace the feed link on the `settleStaged` path too (L7).
- Add the H2 restore test and client tests for the lost-answer and 409 paths (I6).

A re-review can be limited to the N1 fix and its test, plus the THREAT_MODEL changes.

**Crypto review 0001 M1: not closed yet.** Its four requirements now hold at HEAD and are tested on the server: live records are re-encrypted, old versions are decrypt-only, new ciphertexts under old versions are refused, and notifications go only under the current version. Close it together with the sign-off of this review, once N1 is fixed.

## Fixes after the re-review

| Item | Fix | Test |
|---|---|---|
| N1 | A 409 `rotation_conflict` from `/rotate` now refreshes from `/me` and runs the staged check (`stagedOutcome`) before anything is dropped: if the server's fingerprints are the staged keys, the rotation is committed. A second press when the backup is already saved goes through the same check first. Presses while a call runs join it (`oneAtATime`). | E2E: the first `/rotate` answer is dropped after the server rotated; pressing again commits ("Your space has new keys"). Web `rotation.test.ts` "a rotation whose answer was lost" (landed, retry, drop) |
| N2 | When the check finds the rotation landed while an engine runs, that engine is stopped and a new one starts with the new ring (and notifications restart). | Same E2E (sync, re-encryption and the link work after the retry) |
| N3 | `prepareRotation` checks the keys again after the full sync and a fresh `/me`, and refuses unless this device holds the versions being rotated from. | Reading |
| N4 | The stage is marked `tried` before the backup is saved. If the rotation is then dropped, the card says the new phrase is now the one that restores the keys ("Got it" to dismiss). | Reading |
| N5 | THREAT_MODEL reworded: fingerprints don't bind the server. A device link that changes the shared key also shows the safety code before it's used. A key a link replaces is kept in a separate slot ("aside"), never deleted. | Web "replaces this device's orphan key…" (kept aside) |
| N6 | `resolve` holds a record that won't open with a key the device holds: the base and any unsynced change stay, and the push loop stops that pass instead of resending. Deletions open as deletions, so they still apply. | Reading; E2E unchanged |
| H2 | The restore test asked for: after the rotation, a new device signs in, restores from the new phrase alone, and shows the shared item renamed after the rotation. | E2E |
| L1 | The immediate-notification race is recorded in THREAT_MODEL. | — |
| L7 | The feed link is replaced whenever the rotation is committed, on either path. | Reading |
| Info | Backdating and the stuck re-encrypting step are recorded in THREAT_MODEL. The server now has a `ROTATION` switch, "off" in production, for the rotate route and key update links. | API "refuses rotating and key update links when switched off" |

## Re-review 2 (commits e7bed9a, 9ea66f7)

- Reviewer: the same independent agent as the re-review above. It did not write the fixes.
- Date: 2026-11-04
- Scope: `git show e7bed9a 9ea66f7`, and the server switch in ece0cf6 and 6916843. Checked against N1–N6 and the other items listed in the re-review's verdict. The table "Fixes after the re-review" was treated as claims to check.
- Suites, all green at HEAD: `pnpm test:api` (101), `TZ=UTC pnpm test` (668), `e2e:sync` (2). No probes were needed. The client flows in `session.ts` still have no unit tests, so the findings below come from reading.
- Line numbers are at HEAD (9ea66f7). Other people's uncommitted work was in the working tree (notes, places, notification settings). It doesn't touch the rotation paths and was not reviewed.

### Items

| Item | Verdict | Evidence |
|---|---|---|
| N1 | **Partly fixed** | On 409 `rotation_conflict`, `sendRotation` now refreshes and runs `stagedOutcome` before dropping anything (`session.ts:848-857`, `rotation.ts` `stagedOutcome`). A second press with the backup saved goes through `retryRotationNow` (`:791`). Presses during a call join it (`oneAtATime`, `:871`). E2E: the first `/rotate` answer is dropped after the server rotated, the second press commits, and sync, re-encryption and the link work after. Unit tests cover `stagedOutcome`. **Gap:** if `/me` fails right after the 409, the decision uses stale data and still drops the landed keys (R1). |
| N2 | **Fixed** | When `settleStaged` finds the rotation landed, it stops the running engine; `refresh` then starts a new one with the new ring (`:645`). Same E2E. |
| N3 | **Fixed** | `prepareRotation` checks the keys again after `settle()` and a fresh `/me`, and refuses unless both are `ok` for the versions being rotated from (`:752-766`). Reading. |
| N4 | **Partly fixed** | `tried` is set before the backup PUT (`:799`). A dropped rotation shows "your new recovery phrase was saved… keep it" (`AccountCards.tsx:571`). **Gap:** after a reload with `tried` but not `backup`, the stage is kept but nothing shows it and nothing says the phrase may have changed (R3). The notice is only in Privacy, not in a banner. |
| N5 | **Fixed** | THREAT_MODEL now says the fingerprints don't bind the server. A device link that changes the shared key shows the safety code first (`:1040`, `mount.tsx`, `KeyLinkPrompt`). A replaced key goes to the `aside` slot (`keepAside`, `:1065`). The `aside` slot is never read except to add to it. It is not in device links, invites or backups, so nothing leaks. It is deleted on sign-out with the rest of the database, so "never deleted" in THREAT_MODEL holds only until then. There is no way in the app to use it again. Web test "replaces this device's orphan key…". |
| N6 | **Fixed, with trade-offs** | `resolve` returns `'unreadable'` and leaves the base and the unsynced change alone (`sync.ts:438`, `:453`). The push loop stops that pass (`:401`, `:421`). Deletes still apply, because a real deletion opens. Merges stay three-way, because the base isn't replaced. The M5 re-pull only follows `'key'` holds (`:490`), so the two don't mix. Trade-offs are in Info. Reading; E2E unchanged and green. |
| H2 test | **Fixed** | E2E: after the rotation, a new device signs in, restores from the new phrase alone, and shows the item renamed after the rotation. |
| L1 | **Fixed** | The race for immediate notifications is in THREAT_MODEL. |
| L7 | **Partly fixed** | `commitStaged` now replaces the feed link (`:696`). But when a lost answer is resolved at app start, `settleStaged` runs before `startFeeds` loads `feedOn` (`:210`), so `feedOn` is still false and the link isn't replaced. |
| THREAT_MODEL | **Fixed** | Fingerprints, backdating, held records, the notification race, the stuck re-encrypting step and the switch are all recorded. One overstatement: see N5 above. |
| Server switch | **Fixed** | `ROTATION !== 'on'` refuses `/rotate` and rekey links with 403 `rotation_off` (`spaces.ts:136`, `invites.ts:90`). It is "off" in `env.production`, and the API deploy uses `--env production`. Test "refuses rotating and key update links when switched off". `keys-ack` and `/rotation` stay open, which is fine: they only read, or record. |
| I6 | **Improved** | Unit tests for `stagedOutcome`; E2E for the lost answer and the restore. `sendRotation`'s 409 path and the reload paths have no test. |

### New findings

**R1 (Low): a 409 followed by a failed `/me` still drops a rotation that landed.**
- Location: `sendRotation` (`session.ts:848-857`); `refresh`'s offline fallback (`:152`).
- What happens: after the 409, `refresh` asks `/me`. If that request fails (offline, 5xx), `refresh` uses the cached copy, which still shows the old versions. `stagedOutcome` then says `'retry'`, so the stage stays `staged`, and `sendRotation` goes on to `dropRotation`. The 409 itself proved the versions moved. The result is N1's lockout. The message now says to keep the new phrase, which helps, but the only way back is still to sign out and restore.
- Fix: drop only when `stagedOutcome`, run on a fresh `/me`, returns `'drop'`. If `/me` failed, keep the stage for "Try again". Add a test.

**R2 (Low): any other 4xx drops the rotation, including "confirm it's you".**
- Location: `sendRotation` (`:859`); `SecureCard` (`AccountCards.tsx:391`).
- What happens: a 403 `reauth_required` now drops the staged keys. The card still says "Confirm it's you with your passkey, then press Save again", but the form is gone, so the person must start over with yet another phrase. This happens when the client's clock runs behind the server's, because `needsConfirm` compares the server's `signed_in_at` with the local clock. The same happens with 403 `rotation_off` if the UI is on while the server switch is off: every attempt saves a new phrase, then drops.
- Fix: keep the stage on `reauth_required`, as before. Drop only on refusals that mean the rotation can't go ahead. Turn the two switches on together, or have the client check the server switch before saving the backup.

**R3 (Low): a reload after a lost backup answer leaves the N4 case open.**
- Location: `settleStaged` (`:652`); `RotationBanner` (`App.tsx:268`); `SecureCard` (`AccountCards.tsx:467`).
- What happens: with `tried` set and `backup` not set, the stage is kept at start. But the banner and the card show "Try again" only when `backup` is set, and `phraseKept` is not set. So the person isn't told that the backup may now be under the new phrase. If they start again, the `tried` flag is overwritten. A blind "Try again" would be wrong here anyway: the backup may not exist, which would reopen H2.
- Fix: at start, treat `tried` without `backup` as dropped: call `dropRotation`, which shows the phrase notice.

### Info

- **N6 trade-offs.** A record that won't open is now neither stored nor pulled again. A record from the partner's newer app stays invisible after this app updates, until it changes again. Before N6 it was stored and shown at the next start. A held unsynced change leaves the status at "Synced". It also makes `settle()` fail, which blocks starting a rotation and finishing the re-encrypting step until the app updates. Consider keeping unreadable copies apart and pulling them again after an app update.
- **Phrase notice placement.** `phraseKept` shows only in Privacy. A drop found at app start may go unseen. A banner like `PhraseBanner` would be safer.
- **Floor written down on commit.** If a lost answer is found only after the partner rotated again, `commitStaged` writes a floor one version lower than the one just learned. The next `refresh` corrects it, and nothing is sealed wrongly. It breaks "never goes down" for a moment.

### Verdict

**Sign-off with conditions.** No High or Medium findings are left. The remaining problems are narrow recovery paths in the client. None of them can seal under a key the server didn't confirm, or let the server destroy data.

Conditions, before turning anything on:
1. Fix R1, with a test: a 409 followed by a failed `/me` keeps the staged keys.
2. Fix R2: keep the stage on `reauth_required`.
3. Fix R3: at start, a stage with `tried` but no `backup` is dropped, with the phrase notice.
4. Replace the feed link on the start-up path too (L7).

These are small and specific. The author can close them with tests, and no further full review is needed. The Info items are at the owner's discretion.

**Crypto review 0001 M1: closed.** Its requirements hold at HEAD and are tested: live records are re-encrypted until the server counts none left, old versions are decrypt-only, new ciphertexts under any version but the current one are refused, and notifications and reminders go only under the current version. The conditions above are about client recovery, not about these properties.

**Switches.** Turn on `VITE_ROTATION` (UI) and `ROTATION` (server, `env.production`) only once conditions 1–4 are met. Turn them on together, in the same release. With the UI on and the server off, every attempt saves a new phrase and is then dropped (R2).

## Fixes for the re-review 2 conditions

| Item | Fix | Test |
|---|---|---|
| R1 | `refresh` says whether its `/me` answer is fresh. Staged keys are dropped only on a fresh answer (`stagedAction`). After a 409 `rotation_conflict`, the client refreshes; if the stage is still `staged` it says "Couldn't confirm the change" and keeps the keys. | Web `rotation.test.ts` "never drops on a cached answer"; E2E: after the lost answer, `/me` fails twice; the keys survive and the next press commits (fails on the old code) |
| R2 | A refusal is classified (`refusal`): `rotation_conflict` is checked against the server, `multi_space` drops, anything else (`reauth_required`, `rotation_off`) keeps the keys and the new phrase for "Try again". | Web "keeps the keys when a passkey check is needed or the feature is off" |
| R3 | At start, a stage with `tried` but no confirmed `backup` is dropped, with the phrase notice. | Web "drops when another rotation won, or the backup was never confirmed" |
| L7 | Committing a rotation sets `replace-feed`; the feed link is replaced after the feed's state has loaded, at that start or the next. | Reading |
| Info | The phrase notice is also a banner. The floor written at commit goes through `mergeFloor`, so it never goes down. Records that won't open are pulled again once the app has updated (by build). A held unsynced change still shows "Synced": accepted. | Reading |

Switches: both turned on in the same commit: the Secure your space card is no longer behind `VITE_ROTATION`, and `env.production` sets `ROTATION` to "on". Crypto review 0001 M1 is marked closed.
