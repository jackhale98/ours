# 0016. Joining a partner with an existing account

- Status: Proposed; security review 0007 before release
- Date: 2026-11-04

## Context
A partner opens the invite link, then signs in with an email link. That link often opens in another tab, or in the browser instead of the installed app. The invite was kept only in the first tab, so it was lost: the partner was taken through "Set up your space" and made a space of their own. Opening the invite again then hit a dead end ("this device is already set up").

Two fixes:
1. The opened invite is kept in `localStorage` too (dropped after two days, or once used), so it survives the email link. The invite secret already lives on the device next to the keys it unlocks. It's single-use and expires on the server within a day.
2. Someone already caught can still join, which is what this ADR is about.

## Decision
Opening a partner invite on a device that is set up, in a space with nobody else in it, offers:

- **Join with this account**, only when that space is empty: no records besides the space's settings. The account, its devices, passkeys and personal key stay.
- **Start over and join** otherwise. This is Delete account (two taps, it says what will be deleted), keeping the invite, so signing in again joins as a new account.

Bringing an existing space's plans and lists along is left for later.

Joining with this account (`joinWithThisAccount` in `apps/web/src/account/session.ts`):

1. Opens the invite exactly as a new joiner does (`GET /invites/:id`, `openPartnerInvite`), and adds the new space's keys to the existing key ring. The personal key is unchanged.
2. Notes on the device the space being left (`leaving-space`), then accepts the invite (`POST /invites/:id/accept`). If the server refuses (a full space, too many spaces), the note and the new keys are dropped. If the answer is lost, the next start sorts it out:
   - in both spaces: the old one is left;
   - only in the old one: the note is dropped.
3. Leaves the old space (`DELETE /spaces/:id/membership`). The server deletes it, since nobody is left. This is retried on the next start if it fails, and the partner's space is used meanwhile.
4. Clears the old space's local copy (envelopes and outbox), removes its keys from the ring, and starts syncing the partner's space.
5. Asks for a new recovery phrase straight away. The previous backup holds the old ring, without the new space's keys, so the phrase is marked stale until the new one is saved.
6. Shows the safety code to compare, as for any joiner.

On the server, accepting a partner invite also deletes the joiner's passkey unlock copies (ADR 0015). They hold a ring without the new space's keys, and their key versions would wrongly read as current, since space versions start again at 1. They're set up again on purpose.

Other devices of the same account don't have the new space's keys. They show "Welcome back" and take a device link from the device that joined. Until the new phrase is saved, restoring from the old phrase gives a ring without the new space's keys, so that device asks for a device link too. Nothing is lost.

## Consequences
- The safety code comparison protects this join exactly as it does a new account's join: the keys come from the same invite.
- The server learns nothing new: a membership moves from one space to another, as when someone leaves a space and joins another.
- An account with something in its own space still has to start over. That's said plainly in the prompt.
