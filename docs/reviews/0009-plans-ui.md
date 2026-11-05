# Review 0009: Plans (calendar) UI

Date: 2026-11-04 · Reviewer: independent product/UX review (did not build this) · Scope: the Plan tab (agenda, week, month, day drawer), quick add, plan sheet and form, proposals, repeating plans, free time, "Waiting on you", "New from …", and the derived-data code behind them.

Method: production build served with `vite preview`. I drove it with Playwright at phone size (390×844) and desktop size (1280×800), with zone America/New_York and locale en-US. I tested two data sets. The first is the stock demo. The second is a heavy set injected into `ours-demo-v2`:

- 20 repeating series
- a Saturday with 8 overlapping plans and a Thursday with 10
- a two-week "Japan" trip with an overnight flight, plus a partner's conference
- 20 open proposals and 8 of the partner's private plans
- two imported calendars: a full "Work (Google)" calendar with 160 items and a busy-only one
- 10 countdowns
- 1,500 past plans and 200 notes. A "heavier" run used 5,000 past plans and 1,000 notes.

I took timings with and without 4× CPU throttling, and made one CPU profile. Screenshots and scripts are in `/tmp/claude-0/-home-user-ours/9d6a333b-5362-5955-875c-bb40b3367c33/scratchpad/review-plans/` (`b-*` is the stock demo, `h-*` is the heavy set).

## Summary and verdict

The plans UI has unusually careful foundations:

- Recurrence expansion is windowed and zone-correct.
- Each repeating day can be skipped or moved on its own, with undo.
- Privacy is built into the record model (private plans exist only as busy stubs).
- Every grid has a list equivalent, a proper accessible name and keyboard movement.
- "Ask, don't assume" runs through quick add and the plan form.

For a couple with a light-to-normal schedule it is pleasant, clear and fast.

It is **not yet ready for busy schedules or for the full couple workflow.** There are three problems:

1. **Performance degrades with history, not with what is on screen.** With about 2,000 records, a month step takes 0.7–0.8 s on a throttled phone. With about 6,000 it takes 1.3–1.5 s.
2. **The Plan screen does not cope with volume.** Proposals stack as full cards above today. Week and month grids become unreadable or hide plans you cannot reach. Routine series crowd out the plans that matter.
3. **The two-person loop has holes.** Nothing warns about conflicts. Rescheduling or deleting a shared plan is silent and never asks. The partner cannot suggest another time. Two people editing the same plan at once lose each other's changes.

Most fixes are small or medium and fit the app's principles: everything runs on the device, nothing needs a server.

**Overall: strong base, B− today for busy couples. It can reach best in class with the "Now" and "Next" items below.**

## What works well

- **Windowed recurrence** (`packages/core/src/time/recurrence.ts`). `windowDates` starts near the window instead of walking a series from its first day. The cost of series is not the problem.
- **One day of a series on its own.** "Just Thu, Nov 12 · Move this day · Skip this day", with undo and "Put it back" (`b-phone-sheet-repeat.png`). This is clearer than most calendars' "this event / all events" dialog.
- **Quick add** with live chips for the day, time, repeat and place (`b-phone-quick.png`). "Dinner tomorrow 7pm @ Vic's", "every tue and thu 7am", "12:30-2" and "21 nov" all parse correctly, and the date and time fields stay editable.
- **Privacy model.** The partner's private plans appear as hatched "Busy" with no details on the device. The owner sees "Alex sees 'Busy'" on their own row.
- **"Both free this evening → Plan something"** links free time to date ideas with fit-by-length filtering. No mainstream calendar does this.
- **Accessibility.** Rows carry screen-reader prefixes ("Alex's: tentative, …"). Month cells have full day labels ("Tuesday 5 November, 3 plans, both free this evening"). Grids have one tab stop with arrow, Page and Home/End keys. Markers use shape, not only colour.
- **Phone month plus day drawer** (`b-phone-month.png`, `h-phone-month-drawer.png`). Swipe between months, swipe up for the day, a one-line preview, and Escape support. The drawer is well made.
- **Small, contained bundle.** The main UI chunk is about 33 KB gzipped.

## Findings, ranked by impact

### P-1 · High: Every view's cost grows with total history, not with what is shown

**What I saw.** Rough timings, measured as click to the next frame:

| Data | CPU | Load to agenda | Month → next | Week → next | Accept a proposal |
|---|---|---|---|---|---|
| Stock demo (~60 records) | 1× / 4× | 115 / 419 ms | 15 / 75 ms | 14 / 37 ms | — |
| Heavy (~2,000 records, 790 KB) | 1× / 4× | 259 / 1,090 ms | 114–161 / 676–838 ms | 71–82 / 386–456 ms | 109 / 565 ms |
| Heavier (~6,000 records, 2.5 MB) | 1× / 4× | 357 / 1,620 ms | 251–298 / 1,321–1,501 ms | 190–257 / 972–1,034 ms | 319 / 1,427 ms |

The profile of four month steps on the heavier set shows where the time goes:

- About 45% is time-zone conversion (`TZDate` and the `Intl` offset lookup behind `toInstant`).
- About 12% is `hhmm()` in `select.ts`, which calls `toLocaleTimeString` with options once per row and so builds a formatter each time.
- About 5% is `byKind()` filtering, mostly `commentsFor()` running once per row inside `rowsFor`.

The causes in the code:

- `computeAgenda` passes **every** event and busy stub through `expand()`. For a plan that does not repeat, `expand` converts its start and end to instants before checking the range, so each of 5,000 past plans costs two zone conversions on every render.
- `commentsFor(entry.id)` scans all visible records once **per occurrence**. A daily series in a 42-day month grid triggers 42 full scans.
- `agendaCache` clears completely once it holds more than 12 keys. The agenda (7 or 14 days), month (42), `freeEvenings(14)`, `freeStretches(date)` (1 day each) and the week views together can churn it.
- Every write rebuilds everything, because `visible` changes. In demo mode a write also re-serialises the whole store to localStorage (790 KB to 2.5 MB).

**Why it matters.** A couple who uses the app for two or three years builds up thousands of plans. A month view that takes about 1 s per swipe on a mid-range phone feels broken, and the slowdown grows quietly with use.

**Recommendation.**
1. Skip plans that do not repeat by comparing date strings (`start.slice(0,10) <= lastDay+1 && end >= firstDay-1`) before calling `expand`. This is the biggest win. (S)
2. Make one cached `Intl.DateTimeFormat` for `hhmm`, and also for the `freetime.tsx` copy. (S)
3. Build indexes once per store version: records by kind, and comment counts by parent id. Use them in `byKind`, `commentsFor` and `findEntry`. (S/M)
4. Cache occurrences per event, keyed by record identity (`id` and `updated_at`) and window, so one write recomputes one event instead of all of them. Replace the clear-all cache with a small LRU. (M)
5. Add a performance test to CI with a generated 5,000-record store, and set a budget, for example a month step under 50 ms at 1×. (S)

### P-2 · High: Proposals stack as full cards above today's plans; past ones never leave

**What I saw.**
- With 16 open proposals on a phone, the agenda shows 16 lavender `AskCard`s before "Today". The first day starts **4,189 px** down, about five screens (`h-phone-agenda-top.png`, `h-desk-agenda-top.png`).
- On desktop, the countdown column is also unbounded: 10 milestones push "Waiting on you" off the first screen.
- `awaitingMe` (`select.ts`) has no date filter, so a proposal for a past date stays on the Plan screen with "Yes, add it". "Waiting on you" (`inbox.ts`, `upcoming()`) correctly drops it, so the two disagree. I verified this with "Old question from last week" (`b-phone-stale-ask.png`).
- The same proposal also appears again in the agenda with a "Needs your answer" tag, and in "New from Alex".

**Why it matters.** The Plan tab's first job is "what's next". Under volume, the queue of questions takes over the screen, and stale questions never leave.

**Recommendation.**
- Show at most one or two `AskCard`s, then a single row: "14 more need your answer → Go through" (the inbox already exists).
- Filter `awaitingMe` with the same `upcoming()` rule that `inbox.ts` uses.
- Cap the countdown list on desktop (for example, the next 4 plus "All milestones").
- Effort: S.

### P-3 · High: No conflict awareness anywhere

**What I saw.**
- I typed "Dinner tomorrow 7pm @ Vic's" in quick add. It offered "Send to Alex" with no hint that I already have Book club from 7 to 9 PM that evening (`b-phone-quick.png`, `b-phone-agenda.png`).
- In the heavy set, the proposal "Drinks with Max (tomorrow 7–9 PM)" collides with the same Book club. "Ikea run" (Saturday, 11 AM–1 PM) overlaps "Leo's 5th birthday party". Both `AskCard`s say nothing (`h-desk-agenda-top.png`).
- During the two-week "Japan" trip, marked Away, the agenda and week grid still show Swim, Gym, Standup and Walk the dog on every day as if they were happening (`h-phone-agenda-trip.png`, `h-desk-week3.png`).
- Searching for `conflict|overlap|clash` in `apps/web/src/app` finds only layout code.

**Why it matters.** "Ask, don't assume" works best when the person asking and the person answering can both see a clash. Everything needed is already on the device: the partner's busy stubs and both people's imported calendars.

**Recommendation.**
- Add a pure `conflictsFor(start, end, owner)` built on `agendaFrom`.
- Show a one-line hint:
  - in the quick add chips, for example "⚠ Overlaps Book club (yours)" or "Alex is busy";
  - on the `AskCard` and the plan sheet, for example "You have Book club then";
  - as a subtle marker on overlapping agenda rows.
- Dim or flag routine plans that fall on Away days. Better still, offer "Skip these while you're away" (see P-6).
- Effort: M.

### P-4 · High: Rescheduling or deleting a shared plan is silent; the partner cannot suggest another time

**What I saw.**
- `PlanForm` hides "Ask Alex first" when editing. `updateEvent` keeps `status: 'confirmed'`.
- `notices.ts` only has `noticeProposal`, `noticeAnswer` and `noticeNote`. Nothing announces an edit, a move or a delete.
- Moving "Dinner with Jordan & Priya" from 7:30 to 9 PM therefore just happens. The partner learns of it only if they open the app and read "New from Sam".
- That card (`news.ts`, `h-phone-news.png`) lists the plan's *current* state, with no "moved from 7:30 PM", "renamed" or "new". Deletions never appear, because the record is gone.
- On a proposal, "Reply" only opens the notes thread. The answers are yes, "Can't make it", or a free-text note. There is no "How about Sunday instead?" that carries a time.

**Why it matters.** This is the core couple workflow. Today, rescheduling contradicts the app's own principle, and a change to a shared plan can go unnoticed. Howbout and TimeTree make "who changed what" visible. Fantastical, Google and Outlook support "propose new time".

**Recommendation.**
1. When the time or day of an **Ours** plan, or of a plan the partner accepted, changes, ask "Ask Alex about the new time?" (on by default). That turns the edit into a proposal with `previous: {start, end}` kept, so the card can say "Sam wants to move this: Fri 7:30 PM → Sat 7 PM". (M)
2. Send a notice for edits and deletes of shared plans. Keep a small change summary on the device, for example the previous `start`, `end`, `title` and `location`, so "New from …" can show "Moved", "Renamed" or "Removed" with an undo-style "Show". (M)
3. Add "Suggest another time" on a proposal: a date and time picker that answers with a counter-proposal. (M)

### P-5 · High: Concurrent edits to the same plan overwrite each other

**What I saw.**
- `packages/core/src/sync/merge.ts` sets `FIELD_MERGE_KINDS = {item, settings}`, so events resolve last-writer-wins per **whole record**.
- An event record holds both people's reminders (`remind: {a, b}`), the skipped and moved days (`except[]`), the status, the place and the notes.
- So any of these concurrent pairs loses one side:
  - I add my reminder while Alex moves the time;
  - I skip Christmas while Alex skips New Year;
  - Alex says "Yes" while I fix the place.
- Offline-first makes this more likely: two phones editing on the train and syncing later.

**Why it matters.** Changes are lost silently between the two people the app is built for. Reminder loss is invisible until the reminder fails to fire.

**Recommendation.**
- Add `event` and `busy_stub` to `FIELD_MERGE_KINDS`. `remind` is a plain object, so `mergeFields` already handles it per person.
- Merge `except` as a set keyed by `at`, with the later write winning per key.
- Keep last-writer-wins for the `start`/`end`/`all_day`/`tz` group as one unit, so a time is never half-merged.
- Add a test per pair above.
- Effort: M.

### P-6 · Medium: Repeating plans are hard to manage at scale; one edit silently undoes skipped days

**What I saw.**

*Data loss, verified.* I skipped the Thursday, Nov 12 "Trash & recycling out", then edited the series time (9:00 to 9:30 PM). Nov 12 came back. `updateEvent` clears `except` whenever `start`, `rrule`, `all_day` or `tz` changes, without telling the user. With an earlier skip of Christmas, changing the series time from 7 to 8 PM would bring Christmas back.

*Editing the whole series is the only option, and the screen does not say so.*
- From an occurrence, "Edit" opens the series form, showing the series' **first** date (Nov 5) even though it was opened from Nov 12 (`b-phone-form.png`).
- There is no "this and following". Changing Gym from 7 to 6 AM from next month rewrites every past Gym as well.

*The repeat options are thin.*
- The form offers daily, weekly, every 2 weeks, monthly and yearly.
- There is no end date or count (UNTIL/COUNT), and no pick-the-weekdays control in the form. "Every Tue and Thu" is reachable only by typing it in quick add.
- There is no "monthly on the 2nd Tuesday".
- "Spanish class for 10 weeks" cannot be expressed. Ending a series means deleting it, history included.

*Skipping a run of days is one tap per day.* Clearing two weeks of daily "Walk the dog" during the trip takes 14 separate skips. The cap is 200 skipped or moved days per series (`MAX_EXCEPTIONS`).

**Recommendation.**
- Keep skipped days when only the time of day changes (re-key `at` to the new time), and warn before dropping them otherwise. (S)
- Label the button "Edit all days" when the sheet was opened from one day, and default the form's date to that day. (S)
- Add "This and following". Implement it as a split: set UNTIL on the old series and create a new series. (M)
- Add "Ends: never / on date / after N times" and a weekday picker. (S/M)
- Add "Skip from … to …", and "Skip during Away days" offered when a trip is created. (M)

### P-7 · Medium: The desktop week grid breaks down on busy days, and some plans cannot be reached

**What I saw** (`h-desk-week.png`, `h-desk-week2.png`):
- On a 10-plan Thursday, titles shrink to one or two letters ("D.", "S.", "E.", "B.").
- The "+4" overflow is a plain `<span>`. Clicking it does nothing.
- The day headers ("Thu 12") are not buttons. On wide screens there is no day strip, so the day panel under the grid stays on the selected day (Wed, Nov 11 in my run) and **cannot be switched by mouse.** The four hidden Thursday plans are unreachable from the week view; you have to go to Month or Agenda.
- A single overnight flight (Sun 10:30 PM to Mon 12:30 PM) pulls the next week's grid to start at 12 AM, adding six empty hours at the top (`h-desk-week3.png`).
- There is no current-time line.
- The grid has 87 tab stops in one busy week.

**Recommendation.**
- Make the day headers and "+N" buttons that select the day, so the day panel shows that day's full list. (S)
- Base the visible hour range on most plans, for example the 5th to 95th percentile, and clip outliers with an "↑ 10:30 PM" stub. (S)
- Add a now-line. (S)
- Consider an event's own title width (minimum lane width plus a tooltip) or a "Day" view on desktop. (M)
- On phones the week view (strip plus list) holds up well under load (`h-phone-week-thu.png`).

### P-8 · Medium: The month view stops answering "when are we busy?" under load, and loses meaning on desktop

**What I saw.**

*Phone* (`h-phone-month.png`): every cell shows three or four markers and "+5" to "+20". A light day and a packed day look almost identical. "Both free" rings disappear because routines fill the evenings.

*Desktop* (`h-desk-month.png`):
- Cell titles are the first two or three rows sorted by time, so Swim, Gym and Standup fill every cell. "Brunch with the Kims" or "Leo's party" sits behind "+8".
- The titled plans carry **no** whose, tentative or busy cue. `Markers` only draws rows after the titles, so "Busy" and "Hike at Breakneck" (a proposal) read as plain text.
- Multi-day plans ("Japan · Tokyo & Kyoto", "Work trip · Chicago") repeat in every cell instead of spanning. The same happens in the week all-day row (seven "Japan · Tokyo…" chips).

**Recommendation.**
- Rank content within a day:
  1. multi-day and all-day
  2. one-off Ours plans
  3. proposals
  4. one-off personal plans
  5. imported plans
  6. repeating series

  (S)
- Put a marker before each title on desktop, and use the dashed and hatched styles for titles too. (S)
- Add view filters: Mine / Alex's / Ours / Imported / "Hide routines". Store them per device. (M)
- Draw spanning bars for multi-day plans in month and week. (M)
- Optionally, show a density tint or a count instead of "+N" on phones. (S)

### P-9 · Medium: Quick add has gaps that silently produce wrong plans

**What I saw** (UI parse results, today = Wed, Nov 4):

| Typed | Result | Expected |
|---|---|---|
| `Haircut 2:30` | Today **2:30 AM** | 2:30 PM |
| `Dentist 11/14 3pm` | **Today** 3 PM ("11/14" stays in the title) | Nov 14 (en-US) |
| `Pay rent on the 1st every month` | Today, monthly on the **4th** | Monthly on the 1st |
| `Weekend in Hudson sat-sun`, `Trip to Lisbon dec 3-10` | One day | A multi-day plan |
| `Meeting 9am for 2 hours` | 9–10 AM ("for 2 hours" stays in the title) | 9–11 AM |
| `Call mom in 2 days`, `Dinner next week` | Today | Nov 6 / next week |
| `Gym 7am #private` (default Whose = Ours) | "Send to Alex", not private | Mine, private |
| `Breakfast 8` | All day | 8 AM |

Defaults add friction too:
- Every quick add starts as **Ours + "Ask Alex first"**, and the choice is not remembered. A personal entry like "Dentist" takes two extra taps, or becomes a proposal to the partner by mistake.
- `parsed.ask` (a trailing "?") is parsed but never used.

**Recommendation.**
- Bare `H:mm` should follow the same 8–11 am / 12–7 pm rule as "at H". (S)
- Read numeric dates in the locale's order (M/D for en-US, D/M elsewhere), and show the resolved chip as now. (S)
- Support `the 1st/15th` with "every month", date ranges (`sat-sun`, `dec 3-10`, `fri to mon`), `for N hours/mins`, and `in N days/weeks` / `next week`. (M)
- `#private` should switch Whose to Mine. Remember the last Whose choice on the device. Let "with Alex" or "us" mean Ours. (S)

### P-10 · Medium: The agenda is a fixed 7- or 14-day window

**What I saw.** "This week" plus "Show next week" is all the agenda offers. There is no later and no earlier, and no jump to a date. With the heavy data, one week is already about 9,700 px on a phone, because there is no collapsing of routines.

**Recommendation.**
- Make the agenda scroll indefinitely: render weeks lazily with an IntersectionObserver.
- Add "Earlier" at the top and a "Jump to date" control.
- Add an option to collapse repeating series into a single "+6 routines" line per day.
- Effort: M.

### P-11 · Low: Overnight and multi-day continuations are confusing

**What I saw.** On Monday, the overnight flight sorts **last** and shows "10:30 PM / 12:30 PM", which is the previous day's start (`h-phone-agenda-trip.png`). The trip shows "All day · Away" every day, with no "Day 3 of 14".

**Recommendation.** On continuation days, show "Until 12:30 PM" and sort it first. Show "Day n of N" for multi-day plans. Effort: S.

### P-12 · Low: Free-time logic is inconsistent and fixed

**What I saw.**
- `isEveningFree` counts imported items marked free as busy. `freeStretches` excludes them, so "Focus time · free" at 6 PM would hide "Both free this evening" but not the free-time sheet.
- The evening is fixed at 17:00–22:00, and the day at 08:00–22:00.

**Recommendation.** Use the same filter in both functions. Make the evening window a shared setting, for example for shift workers. Effort: S.

### P-13 · Low: Time zones and travel

**What I saw.** The form sets `tz` to the device zone, with no zone picker. Flights cannot have a different arrival zone. A plan made while abroad keeps that zone, shown through the small `zoneNote`.

**Recommendation.** Add an optional "Time zone" field, plus a start zone and end zone for travel. Effort: M.

### P-14 · Low: Keyboard and power use

**What I saw.** The only global shortcuts are `N` and `/`. There is no `T` for today, no `D`/`W`/`M` or `1`/`2`/`3` to switch views, and no `J`/`K` or arrows for the previous or next period outside the grids. There is no "Duplicate" on a plan.

**Recommendation.** Add Google-style shortcuts (`T`, `D`/`W`/`M`, `J`/`K`, `E` to edit, `Backspace` to delete with undo), with a `?` help sheet. Add "Duplicate…" to the plan sheet. Effort: S.

### P-15 · Low: The demo cannot show "New from …"

**What I saw.** Demo records have no `by`, so `news.ts` never shows a result in the demo. I had to inject `by` to see the card at all. Reviewers and prospective users never see one of the main couple features.

**Recommendation.** Have the seed mark two or three of the partner's changes with `by: 'b'` and a time after `seenAt`. Effort: S.

## Best-in-class gaps (prioritised)

1. **Conflict hints and "find a time" across days** (Google "Find a time", Fantastical, Howbout). Example: "Next 3-hour slot we're both free on a weekend". Runs on the device over both calendars and busy stubs. Builds on P-3 and `freeStretches`.
2. **Counter-proposals and time polls** (Fantastical proposals, Doodle, Howbout). Offer two or three times and the partner taps one. This fits "Ask, don't assume" exactly.
3. **Change feed with differences** (TimeTree activity, Howbout). Example: "Alex moved Dinner 7 → 8 PM · removed Ikea run". The data stays on the device; only the "previous" fields are needed (P-4).
4. **Filters and colour by person** (Google calendar toggles, TimeTree): Mine / Alex's / Ours / Imported / Routines.
5. **Spanning bars for trips and multi-day plans** (every major calendar).
6. **Series controls** (Google, Outlook, Apple): this and following, ends on or after, custom weekdays, nth weekday of the month, pause for a range or while away.
7. **Drag to move or resize on the desktop week grid, and long-press move on phones** (Google, Apple, Outlook). The design doc lists this under "Not now"; the move logic (`setException`, `updateEvent`) already exists.
8. **Templates and duplicate** (Fantastical templates, Outlook "copy"). "Date night", "Dinner at parents'" and "Gym" come back often; the date ideas list is a natural source.
9. **Phone Day view and now-line** (Apple, Google): an hour timeline for one busy day, with a current-time indicator.
10. **Infinite agenda and jump to date** (Google schedule view, Fantastical list).
11. **Travel time and "leave by"** (Apple, Fantastical). Doing this without a server means user-entered travel minutes, not routing. Later.
12. **Encrypted attachments** (tickets, booking PDFs) on a plan. Later, after encrypted file storage exists.
13. **Week numbers, and a Home-screen badge or widget.** PWAs have limits here. Later.

## Suggested roadmap

**Now (1–2 weeks; mostly S):**
- P-1 steps 1–3, plus the CI performance budget
- P-2: cap the `AskCard`s, filter stale proposals, cap countdowns
- P-6: keep skipped days on a time change; "Edit all days" label and date
- P-7: clickable day headers and "+N", the hour range, a now-line
- P-8: rank month titles and put markers on titles
- P-9: `2:30` rule, numeric dates, `#private` to Mine, remember Whose
- P-11, P-12 and P-15

**Next (one cycle; M):**
- P-3 conflict hints
- P-4: reschedule as a proposal, edit and delete notices with differences, "Suggest another time"
- P-5 field-level merge for events
- P-6: this and following, end conditions, weekday picker, skip a range or while away
- P-8: filters and spanning bars
- P-1 step 4 (occurrence cache)
- P-10 infinite agenda

**Later (L):**
- drag to reschedule
- find a time across days, and polls
- templates
- time-zone and travel fields
- phone Day view
- encrypted attachments
- widgets
