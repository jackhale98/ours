# Changelog

## Unreleased: 1.0.0 release candidate

Everything in the build plan (phases 0–7):

- **Encryption and accounts:** XChaCha20-Poly1305 records with authenticated metadata, per-space and personal keys, a 12-word recovery phrase, magic-link and passkey sign-in, pairing by link with safety codes, device linking.
- **Sync:** encrypted outbox, three-way merge, honest sync status, offline support (PWA).
- **Planning:** plan view, natural-language quick add, proposals with yes / can't make it / ask again, notes on plans, private plans shown to the partner as "Busy", lists of every kind with assignees and private lists, date ideas with "pick one", countdowns, both-free evenings, weekly check-in.
- **Calendars:** import by file or subscription link (relayed, never stored), per-calendar owner and detail level, an opt-in busy-time feed with link rotation and partner consent, `.ics` export.
- **Notifications:** end-to-end encrypted Web Push for proposals, answers and notes; reminders sealed with your own key; quiet hours.
- **Your data:** readable and encrypted export, safe import with preview, account deletion, inactive-account policy.
- **Key rotation:** "Secure your space" after losing a device (ADR 0013).
- **Accessibility:** WCAG 2.2 AA target, shapes as well as colours, colour-blindness checks in CI, axe on every view in light and dark.
- **Operations:** self-hosting guide, incident runbook, legal pages, release build hashes.

Security reviews: [docs/reviews](docs/reviews).
