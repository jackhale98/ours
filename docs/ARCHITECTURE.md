# Architecture

Ours is a local-first PWA. The UI reads and writes an on-device IndexedDB store; a sync engine moves **encrypted** records to and from a Cloudflare Worker in the background. The server is an authenticated relay for ciphertext, plus push delivery and an opt-in busy feed.

```
Web app (GitHub Pages, Preact PWA)            API (Cloudflare Worker, Hono)
  IndexedDB: decrypted cache + outbox   ──▶     /sync/push, /sync/pull   ── D1 (ciphertext + metadata)
  packages/core/crypto (only place       ◀──    Web Push relay (opaque payloads)
  keys and plaintext meet)                      Cron: reminders
```

## Packages

| Path | Role | May import |
|---|---|---|
| `packages/core/crypto` | Envelope encryption, key ring, invites, recovery, safety codes, notification payloads | noble, scure, valibot |
| `packages/core/schema` | Envelope wire schema, record kinds, migrations, UUIDv7, sort keys | crypto/bytes (encoding only) |
| `packages/core/sync` | Push/pull protocol schemas, write clock, merge | schema |
| `packages/core/time` | Zones, recurrence expansion, free-time finder | rrule, @date-fns/tz |
| `packages/core/parse` | Quick-add natural-language parser | — |
| `apps/web` | PWA | all of core |
| `apps/api` | Worker | `schema` and `sync` only — **never** crypto beyond encoding |

## Encryption (summary; see `packages/core/crypto` and ADR 0003)

- **Space key** (32 bytes, versioned) shared by both partners; **personal key** per user; **recovery key** derived from 12 BIP39 words; **invite secret** only in a URL fragment.
- Records: XChaCha20-Poly1305 with a random 24-byte nonce. AAD = length-prefixed `("ours/record/v1", space_id, record_id, scope, owner_user_id, key_version, deleted)`. Use `sealDecodedRecord`/`openDecodedRecord`, which also enforce the private-content scope policy. Kind, schema version, write timestamp, device id and content live inside the ciphertext. Plaintext is padded to 64-byte blocks.
- Busy-only events: full event under the personal key (scope `user`) plus a `busy_stub` under the space key.
- Pairing: the inviter encrypts the space key under `HKDF(s, "ours/invite/v1")`, uploads only ciphertext, and shares `…/join/#<invite_id>.<base64url(s)>`. Both devices then show a 9-digit safety code to compare in person.
- Backups: `Enc(recovery key, key ring)` with AAD `("ours/backup/v1", user_id, version)`.
- Notifications: encrypted by the sender with the space key, relayed opaquely, decrypted in the service worker; each has a random id and an authenticated validity window, so early, expired and duplicate payloads are dropped.

## Data and sync

- Server tables: `apps/api/migrations/0001_initial.sql`. Every column is listed in `THREAT_MODEL.md`.
- Record kinds and validation: `packages/core/schema/records.ts`. Older schema versions are migrated on device; records from a *newer* app version are kept untouched, never rewritten.
- Push: up to 100 envelopes with `base_rev`; the server assigns `rev` from a per-space sequence and rejects stale writes with the current envelope. Pull: `rev > since`, ordered, paged.
- Conflicts: last-writer-wins on the **authenticated** timestamp inside the ciphertext, tie-broken by device id. New writes are stamped `max(now, last_seen + 1)` so causally later edits win despite clock skew. `item` and `settings` merge field by field against the last synced base. A server replaying an old version loses to the newer local copy, which is re-pushed.

## Time

Timed events store wall-clock `start`/`end` (`YYYY-MM-DDTHH:mm`) plus an IANA zone. Recurrence (RRULE) expands in the event's wall-clock time so 09:00 stays 09:00 across DST. All-day events are floating dates. See ADR 0007.

## Hosting constraints

- GitHub Pages project site: Vite `base` from `OURS_BASE`; CSP in a `<meta>` tag (no inline scripts, `connect-src` = self + API origin).
- API on another site: bearer tokens in `Authorization`, no cookies; strict CORS allowlist.
- Invite links use a separate static entry, `join/index.html`, which reads the fragment once and strips it from history.

## Delivery phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Scaffold, CI, docs, ADRs | Done (pending owner decisions in ADRs 0001, 0006) |
| 1 | Core library | Done; independent crypto review signed off with conditions (`docs/reviews/0001-core-crypto.md`) |
| 2 | API: auth, spaces, invites, backups, sync, quotas | Not started |
| 3 | App shell, PWA, local store, onboarding, demo mode, policy pages | In progress: app shell and demo mode live at the Pages URL (local store in `apps/web/src/app/model.ts`, writes validated with the same schema and scope policy as encrypted sync); PWA, IndexedDB, outbox, onboarding and policy pages to do |
| 4 | MVP features | UI built against the demo store: plan, quick add, proposals, event sheet with notes, lists with assignees, private lists, busy-only events, undo toasts, check-in; E2E + axe in CI. Needs sync to be real |
| 5 | Notifications | Not started |
| 6 | Couple features, feed, export | Not started |
| 7 | Hardening and release | Not started |

## Web app structure

- `src/main.tsx` renders the static landing page; app routes (`#plan`, `#lists`, `#checkin`, `#privacy`) lazy-load `src/app/` and its stylesheet, so the landing page ships ~11 KB of JS.
- `src/app/model.ts` is the local record store (signals). Records are `DecodedRecord`s; visibility mirrors a real device (user-scope records only for their owner; a partner's private event appears only as its busy stub).
- `src/app/select.ts` derives the agenda, proposals, countdowns and free evenings from the store using `@ours/core/time`.
- Views: `views/Plan.tsx` (main chunk), `Lists`, `Checkin`, `Privacy` (lazy). Sheets use native `<dialog>`.
- Start-up is split into separate tasks (load, seed, compute agenda, render) to keep Total Blocking Time low on slow phones.

## UX reference

`docs/prototype.html` is the interaction and visual reference; `docs/PROTOTYPE_NOTES.md` maps it to this architecture and lists deliberate differences (accessibility fixes to two colour tokens, self-hosted fonts, recovery-phrase handling, safety-code format). Design tokens live in `apps/web/src/styles/tokens.css`; `pnpm check:contrast` enforces WCAG ratios in both themes.

## Open questions for the owner

1. License: AGPL-3.0-or-later (assumed, ADR 0001) or MIT?
2. App name and custom domain (affects `OURS_BASE` and CORS).
3. Email provider for magic links (needs a DPA).
4. Push: proposed in ADR 0010 — vendor mycelium-web's WebCrypto VAPID + RFC 8291 code into the Worker; no shared package yet.
5. Week start day and default reminder times (assumed Monday; none).
6. D1 jurisdiction (ADR 0006 proposes `eu`).
7. Governing law; public abuse/security/privacy contact address.
8. Starting quotas and inactivity deletion period (assumed: 20 MB/space, 13 months).
