# Review 0007: joining a partner with an existing account (ADR 0016)

- Reviewer: independent agent that did not write the code (build plan §11)
- Date: 2026-11-04
- Scope: commit 3eebb2e ("Invites: survive email sign-in…") and commit 989eeeb ("Join a partner with an existing account…", the change under review, committed while this review was being written), checked against ADR 0016, ADR 0015, ADR 0013, reviews 0005 and 0006, and THREAT_MODEL:
  - client: `apps/web/src/account/session.ts` (`pendingInvite`, `setPendingInvite`, `refresh` (`leaving-space`), `acceptInvite`/`joinSettings`, `ownSpaceEmpty`, `joinWithThisAccount`, `startOverToJoin`, `openKeyLink`, `signOut`), `account/api.ts`, `account/sync.ts` (`start`, `push`, `stop`), `app/App.tsx` (`JoinInsteadPrompt`), `app/mount.tsx`, `app/views/Start.tsx` (`joinedWithAccount`, `Recovery`, `Profile`), `join.tsx`
  - server: `routes/invites.ts` (accept), `routes/spaces.ts` (`DELETE /:id/membership`, `rotateStatements`), `routes/me.ts` (space order), `routes/auth.ts` (invite-gated sign-up)
  - docs: ADR 0016, THREAT_MODEL
  - tests: `apps/api/test/unlock.test.ts` (new test), `apps/api/test/helpers.ts`, the new tests at the end of `apps/web/e2e-sync/pair.spec.ts`
- Verdict (2026-11-04): **Not yet.** A lost answer to the accept throws away the new space's keys while the server has already joined, with no way back in the app (H1). Fix H1, M1–M3 with tests, then a check of the fixes is enough.
- A later working-tree change on top of 989eeeb ("Delete them and join" replaces Start over) was read too. See "Later change" at the end: it makes M2 more important.

The reviewer ran `pnpm test:api` (108 tests, all green). `e2e:sync` was not run. No probes were written: every finding below is from reading the code. Nothing in the repo changed apart from this file.

## Summary

The cryptography holds. The new space's keys come from the invite exactly as for a new joiner. The personal key never leaves the account. There is no way for keys from the two spaces to get mixed up. The server learns only that a membership moved. Passkey unlock copies are dropped in the same batch as the join, and only when the join happened.

The weak points are in the steps around it, which run on the client, one request at a time:

- **A lost answer is treated as a refusal.** `api()` turns every network failure into an `ApiError` (status 0). So the "it may have gone through" branch never runs. The new keys are deleted from the ring while the server has joined the person and erased the invite's key blob (H1).
- **The "next start sorts it out" path only leaves the old space.** It doesn't mark the phrase stale, clear the old space's local data, add the person to the shared settings, or show the safety code (M1).
- **"Empty" is decided from this device's local copy only,** with no sync first. The server then deletes the space (M2).
- **The kept invite outlives sign-out.** On a shared browser, the next account to sign in is offered someone else's invite (M3).

| ID | Severity | Finding | Verified |
|---|---|---|---|
| H1 | High | A lost or 5xx answer to `accept` drops the new space's keys and the leave note while the server has joined. The invite blob is erased, so the keys are gone for this account, and the person ends up in two spaces | Reading |
| M1 | Medium | Picking up a join after a reload only finishes the leave: phrase not marked stale, no safety code, settings not joined, old keys, outbox and envelopes left | Reading |
| M2 | Medium | The empty-space check is client-only and runs on unsynced, partial local data. Records on other devices, or ones this device can't open, are deleted with the space | Reading |
| M3 | Medium | The invite kept in `localStorage` survives sign-out and account deletion. The next account on that browser is offered "Join" for it and gets the inviter's space keys | Reading |
| L1 | Low | "Join with this account" is one tap from a banner that says "your partner's space" without knowing whose it is, and asks for no passkey check | Reading |
| L2 | Low | Other devices of the account: while the leave is pending they keep working in the old space; later their outbox, which isn't scoped by space, is pushed into the partner's space | Reading |
| L3 | Low | A rotation that is still pending in the old space is orphaned. The personal key floor is kept per space and starts again | Reading |
| L4 | Low | A leave retried later turns off every feed link of the account, including one made in the partner's space meanwhile. The retry also doesn't check that the new membership exists | Reading |
| L5 | Low | ADR 0016 and THREAT_MODEL say more than the code does | Reading |
| I1–I7 | Info | See below | — |

## Verified correct

- **The personal key stays private.** `createPartnerInvite` carries `ring.spaceKeys(spaceId)` only (`invitePartner`). Device links, the backup and passkey copies carry the whole ring, but only for the same account (AAD binds `user_id`; `GET /invites/:id` serves device links only to their creator). Joining sends nothing from the existing ring to anyone.
- **No mix-up between the two spaces' keys.**
  - The invite AAD binds the kind and space id. `openSpaceInvite` checks `payload.space_id === spaceId`.
  - `addSpaceKey` uses `setOnce`, so a version can't be replaced by a different key.
  - `SyncEngine` opens and seals only with `ring.spaceKeys(ctx.spaceId)`. `start()` skips envelopes of other spaces.
  - The old space's keys are removed from the ring after the join.
  - Floors, rotation state, compared versions and cursors are kept per space id (`floor:`, `rotation:`, `compared:`, `cursor:`). So the new space starts from the server's values, as a new joiner does, and `activeRing` checks its kids.
- **Replays and stray invites.**
  - The first fetch claims an invite. A used one answers 404. `GET` refuses a space the caller is already in (409 `already_member`).
  - `POST /invites` for a partner needs membership of that space, so nobody can make an invite for the joiner's own space.
- **Passkey unlock copies.** The `DELETE FROM key_unlocks` runs in the accept batch and is guarded by `EXISTS (membership)`. A refused accept (409 `cannot_join`) deletes nothing. The API test covers the join.
- **The leave.** `DELETE /spaces/:id/membership` deletes the space when nobody is left. The space's records, invites, reminders and `key_ids` go with it (cascades and explicit deletes).
- **The stale-backup window.** On the normal path, `phrase-stale` is set and Start goes straight to a new phrase. Restoring from the old phrase on another device gives a ring without the new space's keys, so that device stays in "needs keys". It never uses wrong keys.
- **Start over (989eeeb).** It takes two taps, says what is deleted, and sets the invite again after `signOut` wipes the device. The later change removes it.

## Findings

### H1 (High): a lost answer to `accept` throws away the new space's keys

- **Location:** `joinWithThisAccount` (`session.ts:1142–1153`); `api()` (`api.ts:36–39`); accept (`invites.ts:226–257`); `/me` order (`me.ts:25`).
- **What happens:**
  - `api()` catches every `fetch` failure and throws `ApiError(0, 'offline')`. So `err instanceof ApiError` is true for a lost answer too. The comment "Without an answer it may have gone through: refresh sorts it out" describes a branch that never runs.
  - If the request reached the server and only the answer was lost (a phone switching networks, the app going to the background), the server has:
    - added the membership;
    - set `used_at` and erased the wrapped blob (`wrapped = x''`);
    - deleted the passkey copies.
  - The client then:
    - clears `leaving-space`;
    - runs `r.removeSpace(payload.space_id)` and `saveRing`.
  - The same happens on a 5xx that comes after the batch committed (a Worker error or timeout).
- **Result:**
  - The account is in both spaces. `/me` lists them by `joined_at`, so every device picks the old one.
  - No device of the account holds the partner's space keys.
  - Opening the invite again gives 404 (used). The partner can't send another invite (the space is full).
  - A key update link wouldn't help: `openKeyLink` refuses a rekey for a space that isn't `state.spaceId`, and `rotationBlocked` stops this account rotating while in two spaces.
  - The partner sees "joined" and goes on writing for someone who can't read it.
  - This is the same class of bug as review 0005 H1 and N1.
- **Fix:**
  - Treat only a definite refusal as "nothing changed": a 4xx such as 404 `not_found` or 409 `cannot_join`.
  - On status 0 or a 5xx, keep the keys and the note, and decide from a fresh `/me`:
    - a member of the new space: finish the join (M1);
    - not a member: drop the keys and the note.
  - Better still, make the join and the leave one server call (see M2). Then there is a single answer to lose, and a retry is safe.
- **Tests:**
  - e2e: route `POST /invites/*/accept` with `route.fetch()` and then `route.abort()`. Expect the join to be finished, at once or after a reload.
  - e2e: the same with a 500 after the commit.

### M1 (Medium): resuming a join after a reload only finishes the leave

- **Location:** `refresh` (`session.ts:200–218`); `joinWithThisAccount` (`:1154–1178`); `joinedWithAccount` is an in-memory signal.
- **What happens:**
  - The page can be closed or killed at any point after the accept: iOS suspends PWAs, people close tabs.
  - At the next start, `refresh` only:
    - retries the leave;
    - avoids selecting the old space.
  - It doesn't:
    - **mark the phrase stale.** `phrase-stale` is set only after the accept and the clean-up. Then the backup lacks the new space's keys and nothing says so. The passkey copies are already gone, so this device is the only copy of those keys. Lose it, and they're gone (H1's result, more slowly);
    - **ask for the safety code.** Start's `joined` step comes only from `joinedWithAccount`, and `toCompare` in `SecureCard` needs `key_version > comparedVersion`, which is false at version 1. So the comparison that ADR 0016 relies on is never shown;
    - **add the person to the shared settings** (`joinSettings`). The partner sees "Partner B";
    - **clear the old envelopes and outbox, or remove the old keys** from the ring. The old keys then go into the next backup and device links. For the outbox, see L2.
  - Also, `joinedWithAccount` is lost on a reload between the join and saving the new phrase. The phrase banner remains, but the safety code step doesn't.
- **Fix:**
  - Store a durable `joining` record before the accept: `{ old, new space id, name, step }`.
  - Set `phrase-stale` before the accept, and clear it again on a definite refusal.
  - Run one idempotent `finishJoin()` from both `joinWithThisAccount` and `refresh`. It clears, removes the old keys, joins the settings, and puts a persistent "compare your safety code" prompt in place of the signal.
- **Test:** e2e: reload right after the accept answers (block the leave request). Expect the phrase banner, a safety code prompt, Lee named in Pat's settings, and the old keys gone from the ring.

### M2 (Medium): "empty" is decided on this device's local copy only

- **Location:** `ownSpaceEmpty` (`session.ts:1104`); `JoinInsteadPrompt` (`App.tsx:277`); `state.partnerJoined`, from the last `refresh`.
- **What happens:** `store.value.entries` is what this device has pulled and could open. It leaves out:
  - **records not pulled yet.** No `engine.settle()` runs first. `prepareRotation` does run it, for the same reason;
  - **records written on another device of the account** and not pushed yet (offline, or a tab in the background);
  - **records held for want of keys,** for example when this device has `needsNewKeys`, and records this build can't read (`repull:`, `unreadable:`);
  - **a partner who just joined.** `partnerJoined` comes from the last `/me`.

  The leave then deletes the space on the server, with all of these. Also, in the partner case the old space isn't deleted: the partner is left alone there.
- **Fix:**
  - Client:
    - run `engine.settle()` first and require it to succeed;
    - refuse when `needsNewKeys`, `repull:` or `unreadable:` is set for the old space;
    - read `/me` fresh.
  - Server: do the join and the leave as one batch, for example `POST /invites/:id/accept { leave: old, keep: [settings id] }`. Refuse it unless:
    - the caller is the old space's only member;
    - the old space has no live record (`deleted = 0`) outside `keep`.

    The server can check this without reading anything. This also closes H1's window, L2's window, I6, and the "leave failed, retried later" state.
- **Tests:**
  - API: a join-and-leave is refused when the old space holds another live record, or has a second member.
  - e2e: a plan made on a second page of the same account, not yet pulled by the first, blocks the join.

### M3 (Medium): the kept invite outlives sign-out (commit 3eebb2e)

- **Location:** `setPendingInvite` and `pendingInvite` (`session.ts:123–156`); `join.tsx:34`; `signOut` (`session.ts:436`); `wipe()` deletes IndexedDB only; `Profile` (`Start.tsx:374`); `mount.tsx:39–52`.
- **What happens:**
  - The invite fragment, which holds the secret, stays in `localStorage` for two days. Neither sign-out nor account deletion removes it.
  - On a shared or family browser: A opens Pat's invite but doesn't finish. Within the server's 24 hours, B signs in to their own account there.
    - If B is new, Profile says "Join the space" and the button says "Join". `acceptInvite` claims the invite and gives B Pat's space keys, so B can read Pat's space.
    - If B is set up and alone, B gets "Join your partner's space?" and one tap does the same (L1).
  - The safety code doesn't catch this: the keys are the real ones. Only Pat noticing a stranger's name does.
  - Where sign-ups are invite-gated (`ALLOW_SIGNUPS` not `open`, for self-hosters), B's sign-up itself also claims A's invite (`auth.ts:197`).
  - Device links (whole-ring secrets) are kept the same way. The server serves those only to their creator, so this is lower risk.
- **Fix:**
  - Clear the kept invite in `signOut` and in account deletion. (`startOverToJoin`, while it exists, sets it again afterwards.)
  - Move it from `localStorage` to `sessionStorage` once a sign-in completes, so it doesn't linger for the next account.
  - Show whose invite it is before joining (see L1).
  - Use a TTL no longer than the server's (24 h).
  - Record in THREAT_MODEL ("Leaked invite link") that the fragment now stays on the device until it's used or for up to a day.
- **Test:** web unit test: `signOut` clears both storages.

### L1 (Low): one tap, and no name, joins an existing account to a space

- **Location:** `JoinInsteadPrompt` (`App.tsx:300–326`); `joinWithThisAccount` doesn't show `payload.inviter_name`.
- **What happens:**
  - The banner appears by itself when the app opens. It says "This is an invite to your partner's space" before anything has been opened.
  - One tap leaves the person's space, deletes their passkey unlock copies, and leads to a new phrase that replaces the backup.
  - In contrast, changing keys and adding a passkey ask for `needsConfirm()` / `confirmItsYou()`, and Start over takes two taps.
  - A link from someone posing as the partner, or M3's leftover invite, is joined before the person sees who made it. The safety code comes after the join, and it can't catch a link that is the attacker's own.
- **Fix:**
  - Open the invite first. `GET` only claims it, which is harmless.
  - Ask "Join {inviter_name}'s space?" with a second tap.
  - Call `confirmItsYou()` when `needsConfirm()`.
  - Word it "an invite to a space".

### L2 (Low): other devices of the same account

- **Location:** `refresh` space choice (`session.ts:218`, `me.ts:25`); `SyncEngine.push` (`sync.ts:367–377`) sends every outbox entry with the current `space_id`; `linkWithInvite` (`session.ts:624`) doesn't clear the outbox.
- **What happens:**
  - **While the leave is pending** (it failed and is retried at the next start of the device that joined), the other devices have no `leaving-space` note. They select `spaces[0]`, the old space, and carry on there. Anything written there is deleted when the leave goes through.
  - **Afterwards,** those devices show Welcome back. Their outbox may still hold old-space entries. After they get a device link, those entries are pushed into the partner's space:
    - space-scope ones sealed under the old space key;
    - user-scope ones under an AAD for the old space.

    Nobody can open them. They count against the partner's space, they are lost to the person, and they make the partner's devices mark the space as having unreadable records.
  - No plaintext or key is exposed.
- **Fix:**
  - Store the `space_id` in outbox entries, push only the current space's, and drop entries for spaces that aren't in `/me`.
  - With M2's single server call, the pending-leave window goes away.
  - Tell the other device "This account joined {name}'s space. Link this device from the one that joined", not only "Welcome back".

### L3 (Low): rotation state from the old space

- **Location:** `joinWithThisAccount` doesn't check `rotation.value`; `settleStaged` reads `rotation:{current space}`; the staged ring (`loadRing('staged')`) is global; `floorKey(spaceId)` holds the personal floor too.
- **What happens:**
  - A solo account can change keys (`rotationBlocked` doesn't need a partner).
  - If a rotation is `staged` with its answer lost, or `securing`, when the person joins, it is never settled. After the switch, `settleStaged` looks at the new space's rotation record.
  - If the staged rotation did land, the server's personal version is one ahead. The new personal key sits in the staged ring and is never committed, so this device shows "needs new keys" for good.
  - Separately, the personal-key floor (M6 in review 0005) is stored under the old space's key. In the new space it starts again from what the server says. So a lying server could keep the device on an older personal key (the N5 residual).
- **Fix:**
  - Refuse to join while `rotation.value` is set ("Finish changing keys first").
  - Keep the personal floor per account rather than per space, or carry it over when switching spaces.

### L4 (Low): a late leave turns off the account's feed links

- **Location:** `DELETE /spaces/:id/membership` (`spaces.ts:260–263`) deletes `feed_busy` and revokes every `feed_tokens` row of the user, not just the old space's; the retry in `refresh` (`session.ts:204–213`).
- **What happens:**
  - When the leave is retried at a later start, a calendar feed the person set up in the partner's space meanwhile is silently revoked.
  - The retry runs whenever the account is in more than one space and one of them is `leaving`. It doesn't check that the other space is the one joined.
- **Fix:**
  - Scope the feed cleanup to the space being left. If feeds are per account, skip it when the account stays in another space.
  - Store the new space id in the note (M1), and leave only when that membership exists.

### L5 (Low): docs say more than the code does

- **ADR 0016, step 2:** "If the answer is lost, the next start sorts it out." It doesn't (H1, M1).
- **ADR 0016, "Other devices… Nothing is lost."** Not while the leave is pending, nor for a pending outbox (L2).
- **ADR 0016, Context:** "or in the browser instead of the installed app". On iPhone and iPad, a Home Screen app and Safari don't share `localStorage`, so this doesn't help there. The paste hint does.
- **ADR 0016, "no records besides the space's settings".** Say "as far as this device knows" until M2 is fixed.
- **THREAT_MODEL, "Leaked invite link".** "The app strips the fragment from history" should add that it's kept in `localStorage` until used (M3). Join-with-account should also be listed.

### Info

- **I1:** On a refusal, `r.removeSpace(payload.space_id)` removes every key held for that id, not just the ones just added. With an honest server, there are none. Still: refuse `payload.space_id === old` up front, and on failure restore a `copyRing` snapshot.
- **I2:** `engine?.stop()` (`session.ts:1161`) is called without `restarting`. So the model's backend is the demo one until `refresh`, and a sync pass in flight isn't awaited: it can put into the just-cleared stores or apply into the new store. Use `stop(true)` and await the running pass, as `restartSync` does.
- **I3:** When the join never happened (only the old space is listed), `refresh` drops the note but leaves the new space's keys in the ring. They then travel in backups, device links and passkey copies. Remove them too.
- **I4:** The TTL is checked only when the invite is read, so an expired one stays on disk until the app is opened again. That doesn't matter once the server has erased or expired the invite.
- **I5:** `joinWithThisAccount` claims the invite with `GET`. If the person then starts over instead, the deleted account's claim stays (`claimed_by` has no foreign key), and the new account gets 404. Say "ask for a new invite" in that case. This is moot once Start over is gone (later change).
- **I6:** Two solo accounts that accept each other's invites at the same moment end up each alone in the other's space. M2's server check (the only member, at the moment of the batch) prevents it.
- **I7:** Test gaps. Nothing tests:
  - a refused or lost accept;
  - a failed leave and the retry;
  - a reload in the middle of a join;
  - another device of the account (stale space, outbox);
  - the empty check against unsynced records;
  - `signOut` clearing the kept invite.

## Sign-off

**Not yet.** The design is sound, and nothing found lets the server or another person read keys or plaintext. But a common network failure can lose the new space's keys for good (H1). And the client-only steps can delete data or skip the safety code (M1, M2).

Conditions, with tests:

1. H1: tell a refusal from a lost answer; never drop keys the server may have accepted.
2. M1: one durable, idempotent finishing step: phrase stale set before the accept, settings, clean-up, and a safety code prompt that persists.
3. M2: sync first, and check on the server: join and leave in one call, refused unless the caller is the only member and the space holds nothing else live.
4. M3: clear the kept invite on sign-out and account deletion, and don't keep it past sign-in.
5. L1–L5: fix them, or record them as accepted in THREAT_MODEL. L1 (the inviter's name and a second tap) and L5 are cheap.

M3 applies to commit 3eebb2e, which is already in. It should be fixed before that commit is released, whatever happens to the rest. After the conditions are met, a check of the fixes is enough. A new full review is not needed.

## Later change (working tree on top of 989eeeb)

Read, not run. `joinWithThisAccount(link, { discard })` now also joins from a space that has things in it. The prompt says "Your space has N things in it, which will be deleted" and asks for a second tap ("Tap again: delete N and join"). `startOverToJoin` is removed. ADR 0016 is updated to match.

Avoiding an account deletion and a second sign-in is an improvement. But the person now agrees to a number, N, which comes from this device's store. So M2 is no longer about an "empty" space being wrongly called empty. It's about consent: the space the server deletes can hold more than the N the person agreed to:

- records not pulled yet;
- another device's unpushed writes;
- records this device can't open.

The person is told "1 thing" and loses more. Conditions under this change:

- **M2:**
  - `settle()` first, and refuse when `needsNewKeys`, `repull:` or `unreadable:` is set.
  - Have the server refuse the leave when the space holds any live record outside the set of ids shown to the person. Send the ids with the request. The server compares them with `deleted = 0` records in that space.
- **Export:** offer an export (or say how to make one) in the prompt when N > 0. Deleted records can't come back: nothing is kept on the server, and other devices lose their copy when they next sync.
- **L1:** with deletion now on this path, show whose invite it is in the prompt, and ask for `confirmItsYou()` when `needsConfirm()`. A stray or attacker's invite can now delete the person's plans in two taps.
- The rest of the findings and conditions are unchanged.
