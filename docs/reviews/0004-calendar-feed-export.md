# Review 0004: calendar feed, subscription relay, export and import (phase 6)

- Reviewer: independent agent that did not write the code (build plan §11)
- Date: 2026-11-03
- Scope: commit 6ff30a5 as it stands at HEAD (e308157):
  - busy feed: `apps/api/src/routes/feed.ts`, `apps/web/src/account/feeds.ts`, `FeedControls` in `apps/web/src/app/views/Calendars.tsx`, `packages/core/src/feed`, tables `feed_tokens`/`feed_busy`
  - subscription relay: `apps/api/src/routes/calendars.ts`, `subscribeCalendar`/`refreshCalendars`, `apps/web/src/app/calendars.ts`, parser `packages/core/src/ics/parse.ts` and `expand.ts` (and the `time/recurrence.ts` it calls)
  - export/import: `packages/core/src/crypto/export.ts`, `kdf.ts`, `apps/web/src/app/export.ts`, `views/DataCard.tsx`, `packages/core/src/ics/write.ts`
- Verdict: **No sign-off yet.** Conditions: fix H1 and M1–M2; address or explicitly accept the Lows.
- Re-review (commit c001131): **Sign-off with conditions.** H1, M2, L2, L5, L7 and the Info items are fixed; M1, L1, L3, L4 and L6 are fixed in part. Two conditions remain before public launch: (A) import must wait for a completed sync; (B) recurrence work must be bounded, not just impossible rules rejected. See the re-review section at the end.
- Fixes for A, B, R3, R4 and R5: see "Fixes after the re-review" at the end. Awaiting the reviewer's check.

Findings were confirmed with throwaway probe tests (run against the repo from a scratch vitest config, then deleted) or by reading, as marked.

## Verified correct

- **Feed token:** 256 random bits (`newToken`), only the SHA-256 is stored, lookup is by hash (no timing oracle on the secret), exact-format regex before any work, "new link" revokes the old one in the same batch as the insert, "turn off" revokes and deletes `feed_busy` in one batch. The request log records `c.req.routePath` (`/feed/:file`), not the token. Account deletion cascades both tables.
- **Feed content:** every value written is numeric or a hex digest (`UID` is a truncated SHA-256 of user id and times), so there is no ICS injection. `SUMMARY:Busy`, `CLASS:PRIVATE`. 500 blocks max, blocks over 14 days refused, window clipped to −7/+62 days on write and read.
- **Feed membership (`inFeed`):** the user's own imports and calendars marked as theirs are left out; a calendar the partner imported but labelled as the user's is left out; with "include partner", calendars the user imported for the partner are still left out. Partner busy stubs are excluded unless "include partner" is on.
- **Relay SSRF guard:** `isFetchableCalendarUrl` works on the WHATWG-normalised hostname, the same parser `fetch` uses. These were all refused: `0x7f.1`, `127.1`, `2130706433`, `0177.0.0.1`, `1.1`, `[::ffff:127.0.0.1]`, `1.2.3.4.`, `LOCALHOST.`, `foo.LocalHost`, `ⓛocalhost`, `%6c%6f…`, `metadata.google.internal`, `foo.home.arpa`, the API's own host in upper case with a trailing dot or `:443`, `x.y@evil.com`, `example.com%2F@x`, non-443 ports and `http:`. Redirects are re-checked per hop (at most 3) and must stay on https. Bodies are streamed with a byte counter after decompression, so gzip bombs stop at 5 MB. The response must start with `BEGIN:VCALENDAR`, goes out as `text/calendar` with `nosniff` and `default-src 'none'`, and is not cached. URLs and bodies are not logged.
- **Export crypto:** export key = HKDF-SHA256(recovery key, `ours/export/v1`), separate from the backup key (the recovery key itself, with backup AAD) and from every other label. XChaCha20-Poly1305 with a random 24-byte nonce per file, AAD = length-prefixed (label, version), padding. A wrong phrase and a modified file both fail closed (`export.test.ts`, plus reading).
- **.ics writer:** TEXT is escaped (`\ ; , \n`) with C0 controls and lone surrogates removed; UID and RRULE have all C0 controls stripped, so CR/LF cannot start a new property; TZID must match `^[A-Za-z0-9_+\-/]+$` or the event is skipped; dates are re-validated; folding is octet-based and never splits a code point.
- **Import basics:** every record is validated with the sync schemas and the `scopeAllows` policy, so busy-only events, private lists and `calendar` records cannot be put under the space key. User-scoped records are always re-owned by the importer. Partner busy stubs are skipped. The server refuses to change an existing id's scope or owner (`sync.ts` upsert guard), so a file that flips the scope of an id already on the server is rejected and the client falls back to the server copy.
- **Parser:** linear-time line handling with no backtracking regexes on attacker-sized input (a 5 MB line of `;`, `"`, `\\`, a long `DURATION` and 280k `EXDATE`s each parse in under 2 s). Nesting depth, parameter, property, event and warning counts are capped. `parseIcs` never throws.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| H1 | High | Importing an older export re-shares plans, lists and calendar details the user has since made private, and brings back deleted records | Open |
| M1 | Medium | A hostile calendar can freeze the app for about 16 s per event: RRULEs that never match make rrule.js iterate to year 9999 | Open |
| M2 | Medium | An import isn't tied to a space or slot: an ex-partner's shared data goes to the new partner, and their busy markers become yours | Open |
| L1 | Low | Import trusts `scope`, `updated_at` and authorship fields from the file, and has no preview step | Open |
| L2 | Low | Public feed GET writes a rate-limit row for every unknown token | Open |
| L3 | Low | Feed data outlives the space and the session; revoked tokens are never purged | Open |
| L4 | Low | The partner's busy times reach the plaintext feed without the partner knowing; "include partner" is a per-device setting | Open |
| L5 | Low | Long-running daily or weekly series lose current occurrences (1000-occurrence cap counted from DTSTART) | Open |
| L6 | Low | The parser uses about 50× memory on many tiny properties, on the main thread | Open |
| L7 | Low | The encrypted export accepts any valid phrase, not this account's | Open |
| Info | — | Several smaller notes (below) | — |

### H1 — Importing an older export re-shares data made private since, and undoes deletions

- **Location:** `apps/web/src/app/export.ts` `importExport` (lines 159–169), with `model.ts` `setEventPrivacy`, `lists.ts` (private toggle), `calendars.ts` `writeSnapshots`/`updateCalendar`.
- **Issue:** making a plan or list private, or changing a linked calendar from "full" to "busy only", creates the private copy under a **new id** and tombstones the old shared one. Deleting a record removes it from the local store. Import only checks `findEntry(item.id)`, so a tombstoned or deleted id counts as absent. The file's copy is then written with the file's scope (`space`) and a fresh timestamp from `put`. The tombstone envelope gives a matching `base_rev`, and the server allows a tombstone to be overwritten in the same scope, so the push is accepted and the partner's device decrypts it.
- **Impact:** a user restores an encrypted or readable backup from last month, a normal "restore my data" action that the UI presents as safe ("everything is already here"). Every plan they have since made busy-only (with title, place, notes and comments), every list they made private, and every full-detail calendar snapshot they downgraded to busy-only is re-sealed under the **space key**, and the partner can read it. Records either partner deleted also come back. This defeats the privacy choice the app promises to honour, and it is the scenario the brief singled out.
- **Verified:** probe tests. (1) A shared event, then export, then `setEventPrivacy(id, true)`, then import of the old file: the old id is back in `space` scope and a `viewer = b` store lists its title. (2) `importCalendar(share:'full')`, then export, then `updateCalendar({share:'busy'})`, then import: a `detail:'full'` space snapshot with titles is back. (3) A deleted shared list comes back. Server acceptance was confirmed by reading `routes/sync.ts` (upsert `WHERE records.rev = base_rev AND same scope/owner`, no deleted check) and `account/sync.ts` (`base_rev` from the stored tombstone envelope).
- **Fix:**
  1. Remember deletions. The account store already holds tombstone envelopes (`envelopes` with `deleted`), so import must treat a tombstoned id as present and newer: skip it unless the user explicitly asks to restore deleted items. Do the same for the demo store (keep `removedAt` persistently, or keep tombstones).
  2. Never import a **space**-scoped record whose content is marked private anywhere. Concretely, skip `space` events, comments, items and snapshots whose id is the predecessor of a current private record. Simpler and stronger: keep a local "superseded ids" set when `setEventPrivacy`, the list privacy toggle and `writeSnapshots` move content, and refuse those ids on import.
  3. Default to restoring **user-scoped records only**. Offer shared records as a separate, explicit choice with a count ("12 shared items will be visible to Sam").
  4. Add a regression test for each of the three scenarios above.

### M1 — Hostile calendar: never-matching RRULE freezes the app

- **Location:** `packages/core/src/time/recurrence.ts` `expand` (`rule.all((d, i) => i < MAX_OCCURRENCES && …)`), reached from `ics/expand.ts` `icsOccurrences` and from `importCalendar`/`refreshCalendar` on the main thread.
- **Issue:** rrule.js calls the `all()` iterator only for **matching** dates. A rule that never produces a date makes rrule.js iterate day by day up to its MAXYEAR (9999), whatever `DTSTART`, `UNTIL`, `COUNT` or the 1000 cap say. Examples: `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`, or `BYMONTHDAY=31;BYMONTH=4` (also with `UNTIL=2027…`). `BYSETPOS` larger than the period's set behaves the same way (by reading). `sanitizeRRule`/`isValidRRule` accept all of these. `icsOccurrences`' `workLimit` counts output, not work, so every such event is expanded.
- **Impact:** ~16.8 s of CPU per event for DAILY (WEEKLY ~3 s, MONTHLY ~0.6 s), measured. A calendar with 20 such events, or a public calendar someone is persuaded to subscribe to, freezes the tab for minutes on import and again on every refresh (on open and every 6 h). Recurrence also comes in through partner-written events (`event.rrule` is only `Text(500)` and `isValidRRule`) and through crafted import files. Those take the same `expand` path on every agenda render and every feed recompute, which is a more persistent freeze, though from a less untrusted source.
- **Verified:** probe test timing `icsOccurrences` on one-event calendars (numbers above).
- **Fix:** (a) In `isValidRRule`, reject combinations that can never match: BYMONTHDAY values that don't exist in any listed BYMONTH (Feb 30/31; Apr/Jun/Sep/Nov 31), and BYSETPOS with DAILY, or with WEEKLY without BYDAY. (b) Bound the work, not the output: iterate with `rule._iter` or a custom loop that counts visited periods, or clamp `dtstart` forward to just before `from` (aligned to INTERVAL) for rules without COUNT. (c) Run calendar parsing and expansion in a Web Worker with a time budget (terminate after a few seconds and report "calendar too complex"). Add a regression test with a 1-second budget.

### M2 — Import isn't bound to a space or slot

- **Location:** `apps/web/src/app/export.ts` (`ExportFile.viewer` is written but ignored on import; there is no space id).
- **Issue:** a readable or encrypted export contains everything the user could see, including the **partner's** shared plans, lists, items and comments. After the user leaves and pairs with someone new, importing that file puts all of it into the new space under the new space key. If the user's slot changed (was `a`, now `b`), the old partner's busy stubs pass the `owner !== me` check and are imported as the user's own markers. Events with `owner: 'a'` silently become the new partner's.
- **Impact:** the ex-partner's shared plans, notes and comments are disclosed to the new partner without anyone intending it. Calendar ownership is also scrambled.
- **Verified:** probe test. Export with partner `b`'s shared plan and busy stub, then `loadEntries('b', [])`, then import: both arrive as space records.
- **Fix:** write `space_id` and the viewer's user id into the export. On import into a different space, import only records the user owns or authored (user scope, plus space records whose `device_id` belongs to the user, or whose `owner` is the user's old slot, remapped to the new slot), skip all `busy_stub`s, and say what was left out. Remap the `a`/`b` fields when the slot differs, or refuse.

### L1 — Import trusts the file's scope, timestamps and authorship, with no preview

- **Location:** `apps/web/src/app/export.ts` lines 150–176; `DataCard.tsx` (import applies immediately and syncs).
- **Issue:** the readable export has no integrity protection, and import takes `scope` from the file. `scopeAllows` stops the obvious cases, but not content that is private only through its parent. With a file edited to say `scope:'space'`, comments on a busy-only plan, items in a private list, and the importer's full `cal_snapshot` of a busy-only calendar are re-sealed under the space key (verified with a probe for a comment). `updated_at: 9e15` beats any local copy (verified). Comment `author`, event `owner`/`proposed_by` and own-slot `busy_stub`s are taken as given. A `calendar` record with an attacker URL is imported and then fetched every 6 h through the relay.
- **Impact:** needs someone to get a tampered or crafted file imported. They can then disclose private content to the partner, forge "partner said" comments, plant fake busy times, or set up a beacon on the user's activity.
- **Fix:** derive scope for child kinds from the parent (comment from its parent, item from its list, a full snapshot is user-scoped unless its calendar's `share` is `full`), and ignore the file's scope for them. Ignore file timestamps above `now`. Skip imported `calendar` URLs unless the user confirms. Show a preview (counts per kind and scope, "N items will be visible to your partner") before writing. Wrap the loop in `bulk()`: it currently does one store copy and one outbox transaction per record, which is O(n²) on large files.

### L2 — Feed GET writes a rate-limit row for every unknown token

- **Location:** `apps/api/src/routes/feed.ts` lines 123–131.
- **Issue:** `rateLimit("feed-get:" + tokenHash)` runs **before** the token lookup, so every unauthenticated request with a random 43-character token inserts a new `rate_limits` row: 50 requests made 50 rows in a probe test. There is no per-IP limit on this public route, and the 3600 s window never uses the `RL_AUTH` binding.
- **Impact:** an anonymous client can grow `rate_limits` without bound (for a day) and spend D1 writes, which are shared with sync, at one write per request.
- **Fix:** look the token up first (read only) and rate-limit only valid tokens. For misses, rely on a per-IP limit through the Workers rate-limit binding or a WAF rule, not D1.

### L3 — Feed data outlives the space and the session; revoked tokens are kept

- **Location:** `apps/api/src/routes/spaces.ts` (leave), `account/session.ts` sign-out (`stopFeeds` only), `app.ts` `cleanup`.
- **Issue:** leaving a space deletes records and reminders but not `feed_busy` or `feed_tokens`. `feed_busy` was derived from that space's joint plans, and with "include partner" from the partner's plans and calendars. Signing out on every device leaves the feed live and frozen. Revoked `feed_tokens` rows are never deleted (up to 20 a day per user).
- **Impact:** joint and partner busy times stay published in plaintext, to anyone holding the link, for up to 62 days after a break-up or sign-out. A small amount of table growth.
- **Fix:** on leave (and when the partner leaves, for the remaining member) delete `feed_busy` for the user, or turn the feed off. Say on the sign-out screen that the feed stays on, or offer to turn it off. Purge revoked tokens in `cleanup`.

### L4 — Partner's busy times reach the plaintext feed without the partner knowing

- **Location:** `apps/web/src/account/feeds.ts` (`includePartner`, kept in per-device `kv`); `packages/core/src/feed` (a "both" calendar imported by the partner is included).
- **Issue:** with "include partner", the partner's plans, including their busy-only ones (from busy stubs), and their calendars are published in plaintext to `feed_busy` and to whoever holds the user's link, such as Google Calendar. A "both" calendar the partner imported is always included. The partner has no setting for this and no notice of it. THREAT_MODEL says `feed_busy` exists "only if the user opts in", but the partner never opted in. Because the setting lives in each device's `kv`, turning it off on one device does not stop another device from republishing partner times on its next change.
- **Fix:** document it in THREAT_MODEL and the privacy page. Show the partner an indicator ("Alex's calendar feed includes your busy times") and let them opt out through a space setting that the feed computation honours. Store `includePartner` in a synced user-scoped settings record.

### L5 — Long-running series lose current occurrences

- **Location:** `packages/core/src/time/recurrence.ts` (`i < MAX_OCCURRENCES` counted from DTSTART).
- **Issue:** a `FREQ=DAILY` series that started in 2020 has **0** occurrences in the current window (verified), and a weekly one is lost after about 19 years. Imported work calendars often contain such series.
- **Impact:** missing busy times. "Both free" and the published feed both say the user is free when they are not. This is a correctness issue that shows up as misleading availability.
- **Fix:** start expansion near `from` (clamp DTSTART forward, aligned to the rule) and apply the cap only within the window. Fixing this together with M1(b) is natural.

### L6 — Parser memory on many tiny properties

- **Location:** `packages/core/src/ics/parse.ts` (`parseLine` builds a `Map` per property; up to 5000 properties for each of 5000 events are kept).
- **Issue:** a 5 MB file of `X:1` lines inside events takes about **264 MB** of heap (1.2 s), measured. This runs on the main thread of a phone browser.
- **Fix:** don't retain properties the builder never reads (keep only the known names: SUMMARY, LOCATION, UID, DTSTART, DTEND, DUE, DURATION, RRULE, EXDATE, RECURRENCE-ID, STATUS, TRANSP). Lower `MAX_EVENT_PROPS` to about 200. Parse in a Worker (see M1).

### L7 — Encrypted export accepts any valid phrase

- **Location:** `DataCard.tsx` `submitPhrase`, `core/crypto/export.ts` `sealExport`.
- **Issue:** any checksum-valid 12-word phrase is accepted. A mistyped phrase, for example with a wrong word that happens to pass the 4-bit checksum, produces a backup that the real phrase cannot open, and nothing warns the user.
- **Fix:** before sealing, fetch the account's key backup and check that the phrase opens it (`openBackup`), or compare a key-check value. Refuse otherwise.

### Info

- The feed's `Cache-Control: private, max-age=900` is overwritten to `no-store` by the global security-header middleware (verified). That is fine for privacy, but it differs from the intent and means every poll hits D1. Either keep `no-store` on purpose and delete the dead header, or exempt the feed route.
- Relay: an invalid `Location` (for example `https://[zz/`) makes `new URL` throw, giving a 500 `internal` instead of a 502 (verified). The upstream status code is echoed to the client ("answered 401"), which is harmless. Wrap the redirect resolution in try/catch.
- Relay: `ownHost` is only the request's hostname. If the API is also reachable at its `workers.dev` name, that alias is allowed (verified). Only unauthenticated GETs could be made and the only interesting one is the feed, so the impact is nil. Consider an `API_HOSTS` list. The guard is a deny-list by design; names that resolve to private addresses (`127.0.0.1.nip.io`) are allowed and rely on Workers not reaching private networks, as ADR 0011 states.
- Relay worst case is 4 hops × 10 s. Consider one overall deadline. `normalizeFeedUrl` accepts `http://`, which the relay then refuses, so the client error is unclear.
- The readable export contains subscription URLs (secrets) in clear. The UI warns that the export is unencrypted, but could name this specifically.
- Writer: RRULE is copied verbatim apart from control characters. The schema only checks `Text(500)`, so validate it with `isValidRRule` before writing. That would also cover M1 for exports.

## Sign-off

No sign-off until H1, M1 and M2 are fixed with regression tests. L1–L7 are fixed or recorded as accepted risks in THREAT_MODEL. The Info items are at the owner's discretion.

## Re-review (commit c001131)

- Date: 2026-11-03
- Scope: the fixes in c001131 for the findings above (key rotation in 6691236/4e863fd is reviewed separately and was not looked at here).
- Method: read the diff; `pnpm test` (596 passed) and `pnpm test:api` (88 passed) at HEAD. The working tree held unrelated uncommitted changes from other work. New throwaway probe tests ran from a scratch config and were then deleted.

| ID | Status | Verified by |
|---|---|---|
| H1 | **Fixed on a synced device; see condition A.** `planImport` gives every record a new id, remaps references, and skips any id the device has seen: the store, `removedAt`, and the engine's `knownIds()` (IDB envelopes including tombstones, plus the outbox). The server never purges tombstones, so on a fully synced device a plan made private, a downgraded calendar or a deleted record can't come back. | `export.test.ts` "never brings back…"; reading `sync.ts` `knownIds` and the API (no tombstone purge) |
| M1 | **Partly fixed; see condition B.** `feasible()` rejects impossible month days, ordinal BYDAY with BYMONTHDAY, unsafe BYSETPOS and INTERVAL < 1. `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` is now refused in 0 ms (was 16.8 s). | `time.test.ts` "hostile recurrence rules"; probe |
| M2 | **Fixed for real files.** The export records `space_id`. Shared records restore only into the same space, and files without a `space_id` count as foreign. Busy stubs, settings and shared snapshots are never imported. The partner-scope check trusts the file's `scope` label, though (R3). | `export.test.ts` "moves only personal records…"; reading |
| L1 | **Mostly fixed.** A preview is shown before anything is written. Items and comments take their parent's actual scope. Events go through `createEvent` (fresh busy marker). Calendars restore user-scoped with `fetched_at: null` and their shared copy is re-derived. Writes are wrapped in `bulk()`. File timestamps are no longer used. One fail-open case remains (R4). | `export.test.ts` "takes privacy from the records…"; reading; probe |
| L2 | **Fixed.** Lookup comes first. Misses are limited per client network (`feed-miss:<net>`), hits per token. | `feed.test.ts` "random links do not add rate-limit rows per guess" |
| L3 | **Mostly fixed.** Leaving a space deletes the leaver's `feed_busy` and revokes their link. `cleanup` purges tokens revoked more than a day ago. Still open: the **remaining** member's feed keeps the departed partner's busy times while that partner's consent flag stays in the shared settings, and sign-out still leaves the feed on with no notice. Accept or follow up. | `feed.test.ts` "leaving the space…"; reading `spaces.ts`, `app.ts` |
| L4 | **Fixed in the app.** Partner busy times are included only if `feed_share_busy[partner]` and `feed_include[me]` are both set, and both live in synced settings, not per-device storage. Caveats (Info): the consent is a shared-settings field that either member's device can write (authorship isn't provable, see THREAT_MODEL), so it is cooperative, not enforced. Joint ("both") plans and calendars the partner imported as "both" still go in without consent, as ADR 0011 intends. THREAT_MODEL's `feed_busy` row still says "only if the user opts in"; mention partner-derived blocks and the consent switch. | Reading `feeds.ts`, `records.ts`, `Calendars.tsx` |
| L5 | **Fixed.** `rule.between` over the window; a DAILY series starting in year 1000 now yields its 60 occurrences in the window (was 0). `Occurrence.index` is now the floating start in minutes and is only used for UI keys. | Probe; `time.test.ts`; grep for `.index` |
| L6 | **Mostly fixed.** Only `USED_EVENT_PROPS` are kept, so a file of unknown properties no longer piles up. A file that repeats a *used* property (5 MB of `UID:1`) still keeps up to 5000 per event; measured heap growth was about 100 MB (noisy). Low: keep only the first occurrence of single-valued properties (all except EXDATE) and lower `MAX_EVENT_PROPS`. | Probe |
| L7 | **Fixed.** `isCurrentPhrase` opens the account's server backup with the typed phrase before sealing, and fails closed when offline. | Reading `session.ts`, `DataCard.tsx` |
| Info | **Fixed:** the feed keeps `private, max-age=900` (test); the relay has one 15 s deadline for the whole fetch, an invalid `Location` gives 502, and upstream status codes aren't echoed; `calendarExport` drops RRULEs that fail `isValidRRule`; the UI warns that the readable export contains calendar links. **Not changed (accepted):** `workers.dev` alias not in the own-host check; `normalizeFeedUrl` accepts `http://`, which the relay refuses. | `feed.test.ts`; reading |

### New or remaining issues

**A (condition; Medium, what remains of H1): import can run before the device knows its tombstones.**
`known` is only as complete as this device's sync. After sign-in, `engine.start()` loads IDB, sets the account to `ready` and only then starts the first pull (`void this.sync()`, `session.ts`/`sync.ts`). `DataCard` and `planImport` don't check sync state. The main use of import is restoring a backup on a new or wiped device. If that happens before the first pull finishes, or while the pull is failing (offline, error), every shared record in the file counts as unknown. The stale shared copy of a plan the user has since made private is then written under a **new** id in space scope, and the partner can read it again. Every other shared record is also duplicated. The `known` set is also computed when the preview is made, not when it is applied. Probe: a backend whose `knownIds()` doesn't yet hold the tombstone imports the old shared plan into space scope. **Fix:** allow import only after a full pull has completed in this session (the cursor caught up with `more: false`, and no failed pull since), and say "Finish syncing first" otherwise. Recompute `importContext()` inside `apply()` and drop anything that became known. Add a test with a `knownIds()` that resolves only after a pull.

**B (condition; Medium, what remains of M1): recurrence work is still unbounded for rules that are possible but never match, or that start far in the past.**
`feasible()` covers impossible dates, but an INTERVAL can lock the rule onto days that never match. Also, `rule.between` still walks from DTSTART. Measured per event:

| Rule | Time | Matches |
|---|---|---|
| `FREQ=DAILY;INTERVAL=7;BYDAY=TU`, DTSTART a Monday | ~2.2 s | none, ever |
| `FREQ=DAILY` with DTSTART in year 1000 | ~2.5 s | normal |

A calendar with 100 such events freezes the tab for about 4 minutes on each refresh. Partner-written events are still exposed the same way on every agenda render, because `LocalDateTime` allows any 4-digit year. **Fix:** bound the work itself, not the output:
- For rules without COUNT, move DTSTART forward to the last aligned period before `from - pad` (whole INTERVALs of the FREQ) before calling rrule.
- Reject DAILY rules with BYDAY when `INTERVAL % 7 == 0` and DTSTART's weekday isn't listed. More generally, reject DAILY/WEEKLY rules whose INTERVAL fixes the phase.
- Run calendar parsing and expansion in a Web Worker with a time budget.
- Add tests that hold these cases to under 50 ms.

**R3 (Low): the cross-space check trusts the file's `scope` label.** `(shared && !sameSpace)` reads `item.scope` from the file, but the destination scope comes from the data: `createEvent` puts `privacy: 'full'` events in space scope, and a list goes to space scope unless it is `private`. A readable export edited to say `scope: 'user'` therefore moves a former partner's plans and lists into the new space (probe). Real exports never contain user-scoped full events or user-scoped shared lists, so this takes deliberate editing. Fix: compute "shared" from the destination (`event.privacy !== 'busy'`, `!list.private`, child follows parent) and use that for the space check.

**R4 (Low): a child can fall back to space scope.** In `apply()`, `scopeOf()` returns `'space'` when the mapped parent isn't in the store. That happens when the parent was in the file but wasn't written, or comes later in the write order. The parent filter checks `importing`, which still includes records the filter itself drops later. Probe: a user-scoped comment whose parent comment was skipped is written to **space** scope with a dangling `parent_id`. Fix: fail closed. Skip a child whose parent wasn't written (check `ids.has(parent) || findEntry(parent)` at write time) and never default to `'space'`.

**R5 (Info): feed consent and departed partners.** See L3 and L4 above: the consent is cooperative, and a departed partner's consent flag and busy markers stay in the space. Consider clearing `feed_share_busy[x]` when x leaves, and update THREAT_MODEL.

### Re-review sign-off

**Sign-off with conditions.** The original High and both Mediums are fixed for their stated cases, with regression tests. Before public launch: (A) gate import on a completed sync and re-check at apply; (B) bound recurrence work (move DTSTART forward and/or use a Worker budget) with tests for the two cases above. R3, R4 and the L3/L6 remainders are Low and can be fixed or accepted in THREAT_MODEL. R5 is at the owner's discretion.

### Fixes after the re-review

| Item | Fix | Test |
|---|---|---|
| A | The sync engine reports `caughtUp()`: true once a pull has reached `more: false` in this session, false again after any failed sync. `planImport` refuses with "Finish syncing first" until then, and `apply()` (now async) checks again and recomputes `importContext()`, dropping anything that became known since the summary. | `export.test.ts` "waits for a full sync, and checks again when applying" (`knownIds()` gains the tombstone between plan and apply; a failed sync before apply refuses) |
| B | `time/recurrence.ts` bounds the walk itself. For a series without COUNT the start is moved forward by whole periods to just before the window (the parts rrule would take from DTSTART are written out first, and weekly/monthly/yearly starts move to a period boundary, so the dates are unchanged). COUNT is resolved to an UNTIL once, with a budget of 20,000 periods, and remembered. Every rrule walk has a budget of periods (the window's length plus a few), enforced through rrule's per-period read of `interval`, so a rule whose steps never meet its filters costs the window and no more. INTERVAL is capped at 1000. `icsOccurrences` also has an overall time budget (1.5 s by default). No rules are rejected for being phase-locked; they simply find nothing within the budget. | `time.test.ts`: five phase-locked rules (daily/7 on Tuesdays from a Monday, monthly/12 in June from November, the 31st every 12 months from April, Feb 29 every 4 years from 2025, a weekly rule on Feb 30) each under 50 ms; a daily series from the year 1000 under 50 ms; 22 rules × 3 starts × 2 windows give the same dates as plain rrule from the original start. `ics.test.ts`: 60 costly COUNT rules stop at a 200 ms budget. |
| R3 | "Shared" now comes from the destination: plans by `privacy !== 'busy'`, lists by `!private`, items and notes by their parent (in the file or already here), calendars and their copies never. The file's `scope` label is no longer read for that. | `export.test.ts` "decides shared or not from the records, so a relabelled file can't cross spaces" |
| R4 | At write time a child goes in only after its parent: written by this import, or already on the device and not also in the file. There is no default to `'space'`; a child with no written parent is skipped. Notes that answer notes are written in passes, so file order doesn't matter. | `export.test.ts` "never writes a child whose parent wasn't written", "restores replies to notes in any order" |
| R5 | The partner's busy times go into the feed only while the server lists them as a member. When the app sees they've left, it clears their `feed_share_busy` flag. THREAT_MODEL now describes the consent as cooperative and covers departed partners. | Reading `feeds.ts` `setPartnerPresent`, called from `session.ts` |
