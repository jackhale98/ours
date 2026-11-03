# 0010. Web Push: reuse mycelium-web's WebCrypto implementation

- Status: Accepted (implemented in phase 5)
- Date: 2026-11-03

## Context
The plan asks to reuse the VAPID/Web Push code from my-celium.org's edge workers, because Node's `web-push` does not run on Workers. The owner pointed to https://github.com/jackhale98/mycelium-web. Relevant files there:

- `worker/src/push.ts` (280 lines): VAPID `Authorization` header (RFC 8292, ES256 JWT via WebCrypto), push-service endpoint allowlist (FCM, Mozilla, Apple, Windows) to stop the worker relaying elsewhere, payload limits, 404/410 → forget the subscription, Durable Object queue with alarms for scheduled reminders.
- `src/lib/push/encrypt.ts` (102 lines): RFC 8291 `aes128gcm` message encryption with WebCrypto only (ECDH P-256, HKDF, AES-GCM). In mycelium it runs **on the device** that will receive the message.
- `worker/src/push.test.ts`: tests including fixed-key vectors.

All of it is WebCrypto-only and runs on Workers unchanged.

## Differences in Ours
- **Who encrypts the Web Push layer.** Mycelium is single-user: a device seals reminders for itself. In Ours the sender's device notifies the *partner's* devices, so the Worker applies RFC 8291 using the stored `p256dh`/`auth` of each target subscription. The payload it wraps is already end-to-end encrypted with the space key (`sealNotification`), so the Worker still never sees text. The `encryptPush` function moves to the Worker as-is.
- **Scheduling.** Mycelium uses one Durable Object per subscription with alarms. The plan uses D1 `reminders` + a Cron Trigger every minute. Recommendation: keep the plan's D1 + cron (one place for data, easy account deletion, no extra binding for self-hosters); revisit Durable Object alarms if minute-level cron proves too coarse or costly.
- **Lifetimes.** Ours payloads carry their own authenticated `not_before`/`expires_at`; the push `TTL` header should match `expires_at`.

## Decision
Vendor the two modules into `apps/api/src/push/` with a header crediting mycelium-web, adapt them to Ours' env and D1 tables, and port their tests (including the fixed vectors). Keep the endpoint allowlist.

Do **not** extract a shared package yet: two consumers, ~400 lines, and different scheduling models. Extract later if a third project needs it.

## Licensing
mycelium-web is GPL-3.0-or-later; Ours is AGPL-3.0-or-later. Both are by the same owner, who can license their own code into Ours under AGPL-3.0-or-later. (Independently, GPLv3 §13 and AGPLv3 §13 explicitly permit combining the two.) Record the provenance in the file headers and THIRD_PARTY_NOTICES.md.

## Consequences
- One audited-by-use implementation across both projects; fixes should be ported both ways until a shared package exists.
- The Worker holds a VAPID private key (`wrangler secret put VAPID_PRIVATE_KEY`); rotating it invalidates existing subscriptions, so the app must re-subscribe on 401/403 from `/push/subscribe`.

## Implementation notes (phase 5)
- `apps/api/src/push/encrypt.ts` and `vapid.ts` are the vendored modules; the RFC 8291 test vector and VAPID signature test are ported in `apps/api/test/push.test.ts`. The allowlist also refuses URLs with credentials.
- What the service worker receives is a small JSON wrapper `{v, s (space id), k (key version), p (nonce‖ciphertext)}`. It contains no record id or text.
- Reminders: the device plans its own reminders 8 days ahead and replaces its list on the server (`PUT /push/reminders`, max 64), the model mycelium uses per subscription, but stored in D1 and per user rather than per Durable Object. Reminders therefore need the app to be opened at least once a week to stay current.
- Quiet hours are enforced by the server (it must decide when to send), so the user's quiet window and time zone are stored in plaintext, only if set. Reminders the user set for themselves ignore quiet hours.
- Notifications are sent only after the record they refer to has synced, so a tap always finds it.
- Local end-to-end tests record pushes instead of sending them (`EMAIL_PROVIDER=dev-outbox`, localhost only) and deliver them to the service worker through the DevTools protocol.
