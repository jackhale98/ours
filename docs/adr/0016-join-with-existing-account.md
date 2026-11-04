# 0016. Joining a partner with an existing account

- Status: Accepted. Signed off in security review 0007 (with conditions C1–C5, met; see "After review 0007")
- Date: 2026-11-04

## Context
A partner opens the invite link, then signs in with an email link. That link often opens in another tab, or in the browser instead of the installed app. The invite was kept only in the first tab, so it was lost: the partner was taken through "Set up your space" and made a space of their own. Opening the invite again then hit a dead end ("this device is already set up").

Two fixes:
1. When a sign-in link is asked for, the opened invite is also kept in `localStorage` for that email address, for at most 24 h. After signing in it comes back only if the address matches, and only in that tab; sign-out drops it (review 0007, M3). On an iPhone, the Home Screen app and Safari don't share storage, so there the email link still can't carry it: pasting the sign-in link into the app (offered on that screen) or opening the invite again works.
2. Someone already caught can join with the same account, which is what this ADR is about.

## Decision
Opening a partner invite on a device that is set up, in a space with nobody else in it, opens the invite and shows who it's from (the name inside it, not from the server), and offers to **join with this account**. The account, its devices, passkeys and personal key stay; its own space is removed. If that space has anything in it, the prompt says how many things will be deleted. Either way it takes two taps. Bringing an existing space's plans and lists along is left for later.

Joining (`joinWithThisAccount` in `apps/web/src/account/session.ts`):

1. Blocked while a key change is pending. Syncs first, so the count includes what's on the server and what this device hasn't sent (review 0007, M2). If there's more than the person was shown, it asks again instead.
2. Opens the invite as a new joiner does (`GET /invites/:id`, `openPartnerInvite`), and adds the new space's keys to the key ring. The personal key is unchanged.
3. Notes the join on the device (`joining`), then calls `POST /invites/:id/accept` with `leave: { space_id, records }`. In one batch the server:
   - joins the new space;
   - leaves the old space and deletes it, with everything in it;
   - drops the account's passkey unlock copies (ADR 0015; they hold a ring without the new keys, and space versions start again at 1).

   It does all of that, or nothing. It does nothing if someone else is in the old space, or if the old space holds more live records than `records` (review 0007, H1 and M2).
4. A clear refusal (4xx) drops the note and the new keys. With no answer (offline, a server error), both are kept. The next start asks the server: if the account is in the new space, the join is finished there; if not, the keys are dropped.
5. Finishing a join, whether now or at the next start (review 0007, M1):
   - the old space's keys and local copy go;
   - the person is added to the shared settings;
   - the recovery phrase is marked stale and a new one is asked for, since the old backup lacks the new keys;
   - then the safety code is shown.
6. Every device drops synced and unsent records of any space but the one it uses, unsent writes included, before it starts syncing: the server refuses a push that mixes spaces, so they'd block syncing (review 0007, L2 and C5). The account's other devices land on "Welcome back" and take a device link.

## Consequences
- The safety code comparison protects this join exactly as it does a new account's join: the keys come from the same invite.
- The server learns nothing new: a membership moves from one space to another, as when someone leaves a space and joins another.
- What was in the old space is deleted, not moved: the prompt says how much, and asks twice.
- Until the new phrase is saved, the old phrase restores a ring without the new space's keys. Such a device asks for a device link from the one that joined.
- Accepted risks are listed in THREAT_MODEL.

## After review 0007
H1, M1, M2 and M3 are fixed as above, with tests: a lost answer finished on the next start; more records than agreed; someone else in the old space; a full space; another person signing in on a shared browser. L1: the inviter's name is shown and joining always takes two taps. L2: the local copy follows the space in use. L3 and L4 are accepted (THREAT_MODEL). L5: this ADR and THREAT_MODEL are corrected.

After the check of the fixes: C1, a kept invite for another address is dropped from the tab too; C2, after a lost answer the device asks again when it's back online; C3, the safety code step survives a reload; C4, joining without a passkey check is recorded as accepted in THREAT_MODEL; C5, other spaces' records are dropped by their space, not by a marker.

After review 0007's recommendations: "Keep my space" releases the invite (I8). Joining sends the ids of every record shown as deleted, and the server refuses if anything else in the old space is live (I9). Records this device can't open are counted in the prompt and deleted with the rest, instead of blocking the join (I10). A sign-in link uses the invite given when it was asked for (I11). A join another tab is still sending isn't called off for two minutes (I12).
