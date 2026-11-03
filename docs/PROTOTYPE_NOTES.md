# Prototype notes

`docs/prototype.html` is the UX reference (supplied by the owner on 2026-11-03). We match its information architecture, interaction model and visual direction, not its code. This page records how it maps onto the build plan and where we deliberately differ.

## Adopted as-is

- **Shell:** phone-first; bottom tab bar + floating "New plan" button under 880 px, left rail with a "New plan" button and `N` shortcut above it. Tabs: Plan, Lists, Check-in, Privacy.
- **Plan (home):** "This week" header with date range and an *Encrypted* pill that links to Privacy; countdown strip; "needs your answer" cards for partner proposals (Yes, add it / Reply / Can't make it); 7-day agenda with "Show next week" (14 days); per-day "Both free this evening — Plan something".
- **Ownership markers:** filled (confirmed), outline (tentative / proposed), hatched (busy-only). Rows carry a visually hidden owner label.
- **Quick add sheet:** one natural-language field with live chips (day, time, place), editable Day and Time, "Whose plan" (Mine / Ours / Partner's), "Ask *partner* first" for shared or partner plans, "Keep the details private" for your own.
- **Event sheet:** owner + tentative label, when, place, repeat; accept/decline; privacy switch; notes thread; delete with "Tap again to confirm" and an undo toast.
- **Lists:** pill tabs with counts; private lists with a lock and an explanation that they use your personal key; tap-to-cycle assignee circle (none → me → partner); show/clear done with undo; date ideas with "Pick one for us", "Plan it", "Another".
- **Check-in:** four steps with progress bar (week ahead stats, share out chores, plan time together from shared free evenings + ideas, a note), "Finish" enabled when all four are done.
- **Privacy:** encryption status card, devices, calendar feed (copy + rotate), recovery, export, theme.
- **Visual system:** palette, display + body faces, radii and spacing → `apps/web/src/styles/tokens.css`.

## Deliberate differences

| Prototype | Ours | Why |
|---|---|---|
| Google Fonts at runtime | Self-hosted Latin subsets of Figtree (body, preloaded) and Bricolage Grotesque (display), WOFF2, `font-display: swap` | Plan: no runtime third-party requests. |
| `--faint` `#899497` / dark `#768386` used for text | `#626D70` / `#869294` | Prototype values are 2.9:1 and 4.2:1; WCAG AA text needs 4.5:1. Enforced by `pnpm check:contrast`. |
| `--line-strong` used for input and checkbox borders (1.8:1) | New `--control` token (≥ 3:1); `--line-strong` only for decorative edges | WCAG 1.4.11 non-text contrast. |
| Both people are dots that differ only by colour | Person A = circle, person B = **square**, ours = circle + square; a "What the marks mean" key under the agenda | Colour-blind users: under simulated deuteranopia the person-A colour and "ours" are nearly identical (ΔE ≈ 2), and under protanopia A vs B is weak (ΔE ≈ 13). Shape now carries ownership; CI simulates protanopia, deuteranopia and tritanopia. |
| Fixed people "Sam"/"Alex", blue/rose | Slots `a`/`b` with chosen display names; colours from a small curated set with light/dark pairs (phase 3) | Custom colours must keep the contrast guarantees. |
| Countdowns are a separate list | Events with `countdown: true` (all-day events like "Lisbon trip") | Plan's data model; one less record kind. |
| Free-text repeat ("Every Saturday") | RRULE on the event, rendered as text | Plan's recurrence model (ADR 0007). |
| `next fri` (from the prototype's parser) | Kept: first Friday strictly after today | We changed our parser to match the prototype; the plan says to port its behaviour. |
| Bare `at 5` is not a time | Our parser reads it as 17:00 (8–11 → am, 1–7 → pm) | Superset; chips show the result and it is editable. |
| Title capitalised by the parser | Parser returns text as typed; the UI may capitalise the first letter on save | Keeps the parser pure; decide in phase 4. |
| Safety fingerprint `4F2A 91C0 7E3B D6A8` | Safety code `437 494 122` (9 digits) | Digits are easier to read aloud and compare in person (ADR 0003). |
| Recovery words can be shown again later | Shown and confirmed once during setup; later you can **make a new phrase** (re-wraps the backup) but not view the old one | Not storing the phrase on device means a stolen unlocked device does not also yield a long-lived backup secret. |
| "If you **both** lose your devices…" | Each person has their own phrase. Copy: "If you lose all your devices, these words are the only way back to your private plans and lists. Your partner can re-invite you to shared plans." | Accurate to the key model (personal keys are per user). |
| "See it as *partner*" switch | Kept as a **preview**: renders your own data with your private items masked the way your partner sees them. In demo mode it switches sides fully. | A real device cannot decrypt the partner's private items, and shouldn't. |
| "Decline" deletes the event | Decline = tombstone + encrypted notification to the proposer | Same UX; plan's proposal flow. |
| Chores come from the list named "Home" | A settings field chooses which list is "chores" (default: first shared check list) | No magic names; phase 6. |
| "Both free this evening" = no event touching 17:00 onwards and nobody away | Same rule, zone-aware: nobody has anything between 17:00 and 22:00 in the viewer's zone, and nobody has an `away` all-day event that day (`apps/web/src/app/select.ts`, using `time/free.ts`) | Window configurable later. |
| No notification or quiet-hours settings | Added to the Privacy tab (phase 5) | Plan section 8. |
| Data in `localStorage` | Encrypted IndexedDB + outbox | Plan section 2; demo mode keeps sample data local. |

## Data model additions from the prototype

- `away: boolean` on `event` and `busy_stub` (schema 1; added before any data shipped). All-day "away" events (trips) block shared free evenings; ordinary all-day events (birthdays) do not. Busy stubs carry it so a partner's private trip still blocks "both free".

## Added beyond the prototype

- **Imported calendars** (owner request; ADR 0011): Privacy → "Calendars you already use". Add by subscription link (refreshes via the server, once accounts exist) or .ics file (stays on device). Choose whose calendar it is and whether the partner sees everything or just busy. Imported events appear on the agenda with a calendar label, open read-only, and events marked free don't block evenings.
- **Calendar feed preview**: shows how many busy blocks the feed would contain and which imported calendars it leaves out (your own, to avoid duplicates), with an option to include the partner's busy times.
