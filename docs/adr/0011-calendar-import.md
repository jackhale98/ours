# 0011. Importing existing calendars (subscription links and .ics files)

- Status: Accepted (owner request, 2026-11-03). Subscription refresh needs the API (phase 2+); file import works now.
- Date: 2026-11-03

## Context
People already keep work and personal calendars in Google, Apple or Outlook. To be useful, Ours should show those alongside plans so "both free" is accurate. The owner asked for:

1. Import via subscription links (secret `.ics` URLs).
2. Say whose calendar each one is.
3. Choose whether the partner sees full details or only busy times.
4. The Ours calendar feed must leave out the subscriber's own imported calendars, so events don't appear twice.

## The privacy cost, stated plainly
Calendar providers do not allow browsers to fetch their feeds directly (no CORS headers), so **refreshing a subscription goes through our Worker**. During each refresh the Worker necessarily sees:

- the subscription URL (a secret that grants read access to that calendar), and
- that calendar's contents, in transit.

This is different from everything else in Ours, which the server never sees in plaintext. Mitigations:

- The Worker acts as a **stateless relay**: it fetches and streams the response back, stores nothing, logs nothing but route/status/latency, and never sees the URL at rest (the URL is stored only inside a `calendar` record encrypted with the importer's personal key; the device sends it per refresh).
- Only `https:` URLs to public hosts; private/loopback/link-local addresses are refused, response size is capped (5 MB) and time-limited (to prevent SSRF and abuse).
- **File import** (download the `.ics` from your provider and add it) never touches the server, at the cost of not updating itself.
- The setup screen says, before saving, that refreshes pass through the server.

A malicious operator could log URLs and contents for users who choose subscriptions; this is listed in THREAT_MODEL.md.

## Decision
- New record kinds (`packages/core/src/schema/records.ts`):
  - `calendar` — name, URL (or null for a file), `owner` (a / b / both), `share` (full / busy), last fetch time. **Personal key only** (enforced by the scope policy), because of the URL.
  - `cal_snapshot` — the expanded occurrences for a window (60 days) after each refresh, at most 400. If `share` is `busy`, the shared snapshot has times only (the schema rejects names, titles and places) and the importer keeps a full copy under their personal key. If `share` is `full`, one shared snapshot with titles and places.
- Parsing (`packages/core/src/ics`): our own RFC 5545 subset parser (VEVENT, DATE/DATE-TIME/UTC/TZID incl. Windows zone names, RRULE subset, EXDATE, RECURRENCE-ID, STATUS:CANCELLED, TRANSP), hardened for untrusted input. `ical.js` was considered but is MPL-2.0 (outside the dependency allowlist) and much larger.
- Refresh: on app open and every few hours while open, by whichever of the importer's devices is active; via `POST /calendars/fetch` (phase 2).
- Display: imported events appear on the agenda with the owner's shape marker and a calendar icon; partner-side busy-only items appear as "Busy". Transparent ("free") events are shown but don't block "both free".
- Feed exclusion (`packages/core/src/feed`): a user's feed contains plans involving them (and optionally their partner's), and **omits any imported calendar they imported themselves or that belongs to them**. A shared ("both") calendar the partner imported is included.

## Consequences
- Imported calendars are one-way (read-only). Editing them happens in the source app.
- Snapshot size limits mean very busy calendars are truncated to the nearest 400 occurrences; the UI says so.
- Background refresh while the app is closed is not possible on the web without server-side storage of the URL, which we deliberately avoid.
