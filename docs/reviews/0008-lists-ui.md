# Review 0008: Lists UI at scale

- Reviewer: independent agent that did not write the code
- Date: 2026-11-04
- Scope: the Lists screen and everything a list touches. That means many lists, long lists, the list types (features and starting points), and the everyday workflows a couple runs on them.
  - code: `apps/web/src/app/views/Lists.tsx`, `views/ListViews.tsx`, `itemsheet.tsx`, `lists.ts`, `search.ts`, `views/Search.tsx`, `model.ts`, `sheets.tsx` (plan checklists), the list sections of `styles/app.css`, `packages/core/src/schema/records.ts` (ListData, ItemData), `schema/sortkey.ts`
  - build: `pnpm --filter @ours/web build` at commit 9931726, served with `vite preview` and driven with Playwright at 390×844 (phone) and 1280×800 (desktop)
- Method: I used the seeded demo first. Then I added 43 lists and 2,127 items to the demo store (`ours-demo-v2`, 653 KB). Big shop has 400 items in 14 sections. House projects has 300 to-dos with due dates, repeats and assignees. Date ideas (all of them) has 500 ideas. There are 40 mixed lists of 3–45 items, three of them private. Timings were taken in the page with `performance.now()` around a click and the next frame. They were run without throttling and with 4× CPU throttling, which is roughly a mid-range phone.
- Evidence: screenshots and scripts are in `/tmp/claude-0/-home-user-ours/9d6a333b-5362-5955-875c-bb40b3367c33/scratchpad/review-lists/`. File names are given with each finding. They are scratch files and are not in the repo.
- Nothing in the app changed. This file is the only change in the repo.

## Summary and verdict

**At the size the demo ships with, lists are good, and in places better than the big apps.** Couples get things the mainstream apps don't have:
- due dates that count back from a trip and move with it
- repeats that pass between the two of you
- "we both want" hearts and "pick one for us"
- "we did it" memories
- private lists that really are encrypted with a personal key

Quick add understands "every Monday" and "by Mar 1". Every bulk change has an undo. The list model is consistent: one kind of list, with features switched on and off.

**It does not yet scale, and three basic list moves are missing.** The design assumes a handful of short lists:

1. **Hard to find your list.** With dozens of lists you can't easily tell which list you're on or get to another one. The list pane has no title. On a phone, lists are a row of pills 7,000 px wide, and the selected pill isn't scrolled into view. On desktop, the sidebar is sticky and taller than the screen, so lists below the fold can't be reached.
2. **Nothing can be moved or ordered.** Items can't be reordered or moved to another list. Lists can't be ordered, pinned or archived. Every trip's checklist stays in the list row for good.
3. **Long lists are slow and hard to work through.** Every list is drawn in full, and items with due dates aren't sorted by date. Each tap redoes work over every item in every list. On a throttled phone with 2,000 items, switching lists takes 0.4–1.2 s and a tick takes about 0.3 s after its built-in delay.

There are also a few smaller bugs. A long note makes the whole page scroll sideways on a phone. Section order jumps around as you add things. A pressed chip's count is unreadable. Sort keys get longer each time an item is added to the top, and after about 1,200 such adds they become invalid.

**Verdict: good bones, not yet best in class for heavy use.** Two pieces of work would bring it there:
- **"Now" in the roadmap.** Each item is small: a list title, scrolling the selected list into view, the sidebar, the overflow bug, undo on tick, the chip contrast, and memoised indexes.
- **"Next" in the roadmap.** Move and reorder, a list switcher with archive, sorting by due date, and grocery autocomplete.

None of this conflicts with end-to-end encryption, because everything here can run on the device.

## What works well

- **One model for every kind of list.** A list is a set of switched-on features (`lists.ts` FEATURES), and starting points are presets. Settings explain each switch in one plain sentence (`base-phone-listsettings.png`). This scales to new list types without new code paths. It is cleaner than Todoist's or Reminders' fixed list types.
- **Features made for couples.**
  - Repeats with "taking turns" pass the chore to the other person on each tick (`completeItem`).
  - On a plan's checklist, "Due the day before" follows the plan if it moves (`dueOf`, `base-phone-For_Lisbon.png`).
  - "Who's on it" can be set by tapping the assignee avatar.
  - "We both want" hearts, "pick one for us", and "we did it" with each partner's reaction.
  - Lists can feed the weekly check-in.

  No mainstream list app does these.
- **Quick add parses dates.** "Call mum on sunday every week" becomes "Call mum · Due Sunday · Every week" (`flow-home-quickadd.png`). The section field stays filled between adds, which suits adding to one aisle at a time.
- **Undo almost everywhere.** Bulk due date, assign, section, mark done, remove, start over, clear done and delete list all return an undo through the toast. Removing needs a second tap ("Tap again: remove 3").
- **Real privacy for private lists.** They are written in user scope under the personal key. Switching a list between private and shared re-creates it under the new key, rather than only relabelling it. "Who's on it" is hidden on private lists. The pane says "Only you can see this list. It's encrypted with your personal key."
- **A good accessibility base.**
  - Items are real checkboxes, and each button's label includes the item name ("Details: Eggs").
  - Tap targets are 44 px.
  - Toggle groups use `aria-pressed`.
  - Sections are labelled regions with headings.
  - The bulk-select count is announced.
- **Local search.** It covers item text, notes and sections, and says why it runs on the device.
- **Fast at normal sizes.** With the seed data (5 lists, about 25 items), switching lists takes under 50 ms without throttling.
- **Merging between partners.** Items merge field by field (ARCHITECTURE: "`item` and `settings` merge field by field"). One partner can tick an item while the other edits its note, and neither change is lost.

## Findings

Ranked by impact on a couple who use lists every day.

| ID | Severity | Finding | Effort |
|---|---|---|---|
| L-1 | High | You can't tell which list you're on, and finding a list among dozens is hard (no title, a 7,000 px pill row, the selected pill off screen) | S + M |
| L-2 | High | Lists can't be ordered, pinned, archived or grouped. Plan checklists pile up. The desktop sidebar is cut off when there are many lists | S + M |
| L-3 | High | Items can't be reordered or moved to another list | M |
| L-4 | High | Long lists: no sorting or grouping by due date, every row drawn, the add box scrolls away, about 850 tab stops | M |
| L-5 | High | Each interaction recomputes over every item in every list. On a throttled phone, list switches take 0.4–1.2 s | M |
| L-6 | Medium | Ticking has no undo, and a ticked item disappears into a done list in the original order | S–M |
| L-7 | Medium | Section order changes as you add items, and sections can't be ordered, collapsed or renamed | M |
| L-8 | Medium | Groceries: re-adding a done item makes a duplicate, there's no autocomplete, and quick add ignores quantity and "@name" | S–M |
| L-9 | Medium | Starting points keep the switches but not the items. An existing list can't be attached to a plan | M |
| L-10 | Medium | "Plan it" isn't linked back to the idea | M |
| L-11 | Medium | Idea rows are 99 px tall on a phone, with four actions each and a one-tap × | S–M |
| L-12 | Medium | Lists across all lists ("Due this week", "On me") and Waiting on you get swamped at scale | M |
| L-13 | Medium | A long note makes the page scroll sideways on a phone | S |
| L-14 | Medium | Sort keys grow with each add to the top. After about 1,200 adds they are invalid, and when both partners add at the same moment the keys can tie | S–M |
| L-15 | Low | A pressed chip's count has about 1.1:1 contrast | S |
| L-16 | Low | Desktop keyboard: no list shortcuts, "n" and the + button make a plan, and every row is a tab stop | M |

### L-1 (High): you can't tell which list you're on, or find a list quickly

**What I saw**
- **No list title.** The list pane never shows the list's name. Above the items there is only the starting-point label in small grey text, such as "Groceries" for *Big shop* or "Places to try" for *Hikes*. The page `<h1>` is always "Lists". The eyebrow above it says "Shared with Alex", which describes the current list but sits on the page title.
- **Phone, coming from search.** I opened *Hikes* from search and landed on a page that says "Places to try" (`scale-phone-from-search.png`). Its pill is off screen: the row is 7,021 px wide in a 358 px box, and `scrollLeft` is 0.
- **Phone, after New list.** I made "For Rome" and the pane said "Packing" and "Nothing here yet", with no sign of the name. The new pill sat at x = 500 on a 390 px screen (`flow-new-list.png`).
- **Phone, after bulk select.** Of the pills on screen, none was selected (`scale-t4-phone-bulk.png`).
- **Finding a list on a phone** means scrolling sideways through up to 48 pills. There's no overview, no filter, and no way to jump.
- **Screen readers:** the outline is H1 "Lists", then section H2s ("Dairy", "Bakery"…). No heading names the list.

**Why it matters.** On every screen, people need to know which list they're adding to. "Add to Big sho…" is the only clue, and the placeholder is cut off at phone width (`scale-t4-phone-bigshop.png`). With two people adding to several grocery lists, that means items end up on the wrong list.

**Recommendation**
- **S:**
  - Put an `<h2>` with the list's name at the top of the pane, with a lock icon and "Just for you" or "Shared with Alex". Move the eyebrow onto it.
  - Call `scrollIntoView({inline:'nearest'})` on the selected pill whenever `currentList` changes, including from search, New list and a plan sheet.
  - Use "Add to list" or "Add an item" as the placeholder, since the title now names the list.
- **M:** on a phone, replace the pill row with a list switcher. The current list's name becomes a button that opens a sheet of all lists, grouped (Pinned, Shared, Just for me, Trip checklists, Archived), with a filter box once there are more than about 8 lists. Keep the cross-list views as one "Across lists" entry in that sheet. Reminders, Todoist and Microsoft To Do all use this pattern on phones. Keep the sidebar on desktop.

### L-2 (High): lists can't be ordered, pinned, archived or grouped, and the sidebar gets cut off

**What I saw**
- **Fixed order.** Lists appear in store order, which is roughly the order they were made. `ListData` has no `sort_key`, `archived`, `pinned` or group. Making a list private moves it to the end, because it is re-created.
- **Plan checklists pile up.** Each plan's "Add a checklist" makes a permanent "For …" list. Nothing retires it when the trip is over. Deleting the plan leaves the list behind, without its link to the plan.
- **Desktop sidebar cut off.** With 48 lists the sticky column is 2,436 px tall in an 800 px window. After scrolling 3,000 px into *Big shop*, the last list is at y = 2,413, and everything below *Garden jobs* is unreachable until you reach the bottom of a 15,000 px page (`scale-desk-bigshop-scrolled.png`). The cause is `.ltabs-col { position: sticky }` with no maximum height or overflow.

**Why it matters.** A couple's list count grows: trips, gifts each year, seasonal lists. Without archive and ordering, the two or three lists used every day get lost among old ones. Reminders (groups and pinning), Todoist (project order and archive), Things (areas) and AnyList (folders) all treat this as basic.

**Recommendation**
- **S, now:** `.ltabs-col { max-height: calc(100dvh - 48px); overflow-y: auto }` on desktop.
- **M:**
  - Add `sort_key`, `archived` and `pinned` to `ListData`. This needs a schema v2 and a `MIGRATIONS.list[1]` entry. Note that `ListData` is a `strictObject`, so the partner's older app version must be able to handle the new fields before either device writes them.
  - Let people reorder lists in the switcher.
  - Archive hides a list from the switcher, the check-in and the cross-list views, but keeps it searchable.
  - When a plan with checklists has passed, offer "Lisbon is over. Archive 'For Lisbon'?" in Waiting on you.
- **Later:** groups such as "Home", "Trips" and "Ideas" if people ask for them. Pinning plus archive covers most needs.

### L-3 (High): items can't be reordered or moved to another list

**What I saw**
- Items have `sort_key`, and `keyBetween`/`keysBetween` exist, but the UI only uses them to put new items at the top (`AddItem`).
- There's no drag handle and no "Move up" or "Move down".
- The item sheet has no List field (`base-phone-itemsheet.png`).
- The bulk bar offers Due date, Assign, Section, Mark done and Remove, but no Move (`base-phone-select.png`).

**Why it matters.** These are the most common list edits:
- the packing list in priority order
- the to-dos that matter first
- "this belongs on the Costco run, not the weekly shop"
- "move this idea from Places to try to Date ideas"
- sorting brainstormed gift ideas into one list per person

Today the only way is to delete the item and type it again, which loses its hearts, memories, notes and repeat. Every app the owner would compare against can drag to reorder and move between lists.

**Recommendation (M)**
- Add "Move to…" in the item sheet and the bulk bar, with a list picker.
- A move within one scope is just a change to `list_id` plus a new `sort_key` at the end of the target list.
- A move between a shared and a private list has to re-create the item in the new scope, as `setListPrivacy` does. Confirm it first: "Alex won't see this any more" or "Alex will see this". Drop the assignee when it goes private.
- Clear fields the target list doesn't use, or keep them hidden. Keeping them is simpler and loses nothing.
- Undo through the toast.
- **Reorder:**
  - A drag handle that appears in an "Edit order" mode, or on long-press on a phone, using pointer events and no library.
  - A single-pointer alternative, as WCAG 2.5.7 requires: "Move to top", "Up" and "Down" in the item sheet, and Alt+↑/↓ on the keyboard.
  - Write one `keyBetween(prev, next)` per move.

### L-4 (High): long lists have no order, no grouping, and every row is drawn

**What I saw**
- **No date order.** *House projects* has 225 open to-dos, most with due dates. They show in the order they were added, so overdue items are scattered all through the list (`scale-phone-todo-scrolled.png`). There's no sort control, whether by due date, person, name or recently added.
- **Pages get very long.** Every row is drawn:
  - *Big shop*: 266 open rows, a 15,678 px page on a phone
  - *Big shop* with done items shown: 401 rows, 23,603 px
  - *Date ideas (all of them)*: 500 rows at 99 px each, a 49,127 px page with 9,530 DOM nodes
- **The add box and the Select and Settings bar scroll away**, so adding while you're far down means scrolling back to the top (`scale-desk-bigshop-scrolled.png`).
- **No find within a list.** On a phone the only option is the global Search, which opens the item's sheet rather than its place in the list.
- **Keyboard.** On desktop, *Big shop* has 856 tab stops before "Show done" (checkbox, assign and details on each row).

**Why it matters.** "Hundreds of items" is normal for a couple's shared to-do list or a weekly shop that builds up staples. Without sorting by due date, a to-do list can't answer "what do I do next", and the per-row cost hits slower phones hardest (see L-5).

**Recommendation (M)**
- Lists with Due on should sort by due date by default and group under Overdue, Today, This week, Later and No date. Put the person and the repeat on the same line. Give each list a sort menu (Our order, Due date, Who, A–Z, Recently added), saved per list.
- Make a slim header sticky with the list name, the add box and Select, or float the add box at the bottom on phones.
- Draw progressively. Show the first 100 rows, then "Show 266 more", or add `content-visibility: auto; contain-intrinsic-size: auto 55px` on `.it`. The CSS option is very cheap, uses no library, and keeps Ctrl+F and screen-reader navigation working.
- Add a "Find in this list" filter field once a list has about 30 items or more.
- Make the list a single tab stop with arrow keys inside it (see L-16), and add a "Skip to done" link.

### L-5 (High): every interaction recomputes over all items in all lists

**What I measured** (43 lists, 2,127 items, phone viewport):

| Action | No throttle | 4× CPU throttle |
|---|---|---|
| Reload until the lists appear | 150 ms | 632 ms |
| Switch to *Big shop* (266 rows) | 101 ms | 526 ms |
| Switch to *Date ideas (all…)* (500 rows) | 258 ms | 1,226 ms |
| Switch to *Films* (19 rows) | 45 ms | 236 ms |
| Tick an item (after the deliberate 420 ms delay) | 61 ms | 316 ms |
| Add an item | 77 ms | 320 ms |
| Select one more item in select mode | 40 ms | 189 ms |
| Bulk "Section" on 400 items, and its undo | 120 / 118 ms | 559 / 588 ms |
| A keystroke in Search | 10–28 ms | 59–151 ms |

Switching to a 19-row list still costs 236 ms when throttled. Most of the cost is unrelated to the list on screen.

**Causes, from the code**
- `itemsOf(listId)` filters the entire `visible` array by kind, then by list, then sorts, every time it's called.
  - The list row calls it once per list (`countOf`).
  - `CrossViews` calls `viewItems` four times per render to get the counts. Each call loops over every list and calls `itemsOf`, so one render costs O(lists × entries) four times over.
  - `ListBody`, `AddItem` (on every keystroke, to find section names), `BulkBar` and `ListsView` each call it again.
- `findEntry` is a linear `Array.find`. `dueOf` uses it on each row of a plan checklist. `put()` maps over the whole entries array on every write.
- `ListsView` reads the `selection` signal, and each `ItemRow` reads it too. Selecting one item therefore redraws the whole screen, including the four cross-list counts.
- In the demo, every write saves the whole 653 KB store to localStorage. Accounts encrypt only the record that changed, so this matters for the demo only.

**Why it matters.** The cost grows with lists × items, so it gets worse the more a couple uses the app. 300 ms after each tick is noticeable when ticking twenty things in a shop. A 1.2 s list switch feels broken.

**Recommendation (M)**
- **One index for items.** Add a `computed` signal from `visible` that builds `Map<listId, ItemEntry[]>`, sorted once, plus `Map<id, Entry>` for `findEntry`. Derive the open and done counts per list from the same pass.
- **One pass for the cross-list views.** Compute all four views' items and counts together in a `computed`, not four loops on every render.
- **Keep selection local.** Read `selection` only in the row's checkbox and in `BulkBar`, so selecting an item doesn't redraw `ListsView`.
- **Section names.** Compute them once per list in the index rather than on every keystroke.
- **Size of the change.** No virtualisation library is needed. Together with `content-visibility` (L-4), this should bring the throttled numbers under 100 ms.
- **Check it with a test.** Add a Playwright benchmark with this data set (`gen.js` in the scratch folder) so it doesn't regress.

### L-6 (Medium): ticking has no undo, and done items are hard to find

**What I saw**
- Ticking a non-repeating item shows no toast. In the code, only repeats show "Done. Next: …" with Undo, and the probe found no toast after ticking Eggs.
- The item is gone from the list 420 ms later.
- "Show done" lists done items in their original order, not the order they were ticked. In *Big shop* that is 133 done items, so you have to hunt for the one you ticked by mistake.
- Rows move up 420 ms after a tap. If you tap the next row quickly, as people do in a shop, you can tick the item that just slid under your finger.

**Why it matters.** Mis-ticks are the most common list mistake, and they matter more in a shared list: Alex may think the milk is bought. Every other action in this app can be undone, so this one stands out.

**Recommendation**
- **S:** show "Ticked Eggs · Undo" for every tick. Collect rapid ticks into one toast ("Ticked 3 · Undo").
- **S–M:**
  - Sort done items with the most recently done first. This needs a `done_at`; the record's `updated_at` would do for a first version.
  - Consider an option to keep ticked items in place, crossed out, until you leave the list or tap "Tidy". OurGroceries and AnyList do this, and it stops rows moving under your thumb.

### L-7 (Medium): section order is unstable and can't be controlled

**What I saw**
- Sections appear in the order their first item appears. New items go to the top, so adding to a section moves that section to the top.
- In the seeded Groceries list, adding "Tomatoes → Produce" and then "Frozen peas → Frozen" changed the order from Dairy, Produce to **Frozen, Produce, Dairy** (`flow-sections-reordered.png`).
- A section is free text on each item. A typo ("Diary") makes a new section.
- Sections can't be renamed (except by selecting their items and using bulk "Section"), collapsed or ordered.
- In *Big shop*, items without a section come first, above all sections.

**Why it matters.** Sections exist to follow the shop's aisles or the days of a trip. An order that changes each time you add something works against both. Store-aisle order is the main reason people pay for AnyList or OurGroceries.

**Recommendation (M)**
- Add an ordered `sections: string[]` to `ListData` (this changes the schema).
- New sections go to the end, and existing sections keep their place.
- Section headers can be reordered (with the same alternatives as in L-3), collapsed (kept per device) and renamed. Renaming changes every item in that section, with undo.
- Put new items at the end of their section, or at the top, but never in a way that moves the section itself.
- **Later:** remember sections per item name for grocery lists. Once "Tomatoes" has gone in Produce, it goes there automatically. Keep this in a local, per-list map so it never leaves the device in clear text.

### L-8 (Medium): groceries have no autocomplete, and duplicates build up

**What I saw**
- Adding "Sourdough" while "Sourdough" was in done made two Sourdough rows. Nothing suggested bringing back the done one.
- The add box sets `autocomplete="off"`, and there is no list of suggestions.
- "Milk x2" stayed as the text "Milk x2", with no quantity filled in.
- "Hoover the stairs @Alex tomorrow" got its date, but "@Alex" stayed in the text and the item wasn't assigned.

**Why it matters.** Grocery lists are mostly the same 50 things each week. Typing ahead to bring a done item back is the feature that makes AnyList, OurGroceries, Bring! and Keep fast. Duplicates on a shared list cause double buying.

**Recommendation (S–M)**
- Suggest from the list's own items, done ones included, as the person types. Picking a done item unticks it rather than adding a copy, and exact matches get the same treatment automatically. This all runs locally, so it's fine with E2EE.
- When How many is on, read "2 x", "x2", "2 ×" and "500 g" into `qty`.
- When Who's on it is on, read "@Alex" or "@me" into the assignee.
- Show what was understood as chips under the box before adding, as the new-plan sheet already does with "Friday" and "7 PM" (`flow-plan-it.png`).

### L-9 (Medium): saved starting points don't keep items, and a list can't be attached to a plan later

**What I saw**
- **No items in saved starting points.** `saveStartingPoint` stores the features and the private setting only. A saved "Weekly shop" or "Weekend away" starting point gives an empty list.
- **Copying drops the plan.** "Copy list" copies the items but removes `plan_id`.
- **No attaching later.** There's no way to attach an existing list to a plan. List settings only has "Make it a list of its own".
- **Empty checklists.** "Add a checklist" on a plan always makes an empty Packing list.

**Why it matters.** Couples pack for the same kinds of trips again and again. The natural flow is: new trip, "Add a checklist", start from last trip's list, with every "days before" kept. Today it takes copy, rename and add-again, and the copy can't count back from the new trip's date.

**Recommendation (M)**
- Add a choice under "Save as a starting point": "Include its 34 items". Store the template's items in a hidden list (for example a `template: true` flag on ListData), not in the shared settings record, which should stay small.
- "Add a checklist" offers: start empty, copy "For Lisbon", or use a saved starting point.
- Add "For a plan…" in list settings to attach a list to a plan, and keep each item's `before_days` when one is copied.
- Packing (and maybe Groceries) could suggest a few starter items that can be removed. AnyList and the packing apps do this.

### L-10 (Medium): "Plan it" isn't linked back to the idea

**What I saw.** "Plan it" opens New plan with the idea's text and the next evening you're both free (`flow-plan-it.png`), which is nice. But `openQuick` gets only text, so the plan has no link to the idea. After the date:
- the idea gets no "We did it"
- no "How was Pottery class?" prompt appears
- nothing on the idea shows it's planned, so the other partner may plan it again

**Why it matters.** "Date ideas → plan → memory" is the app's own core loop and what sets it apart. As it stands, the loop stops at the plan.

**Recommendation (M)**
- Pass the item id through the quick preset, and store `from_item` on the event (or `planned` on the item).
- Show "Planned · Fri" on the idea row.
- When the plan has passed, add a one-tap "We did it" with reactions in Waiting on you or the check-in. `memoryToRecall` already brings back memories.

### L-11 (Medium): idea rows are heavy on a phone

**What I saw**
- On a phone, each idea row wraps into two lines, 99 px in all: name and details on one, then heart, "We did it", "Plan it", details and × underneath (`base-phone-Date_ideas.png`). 500 ideas make a 49,000 px page.
- × removes the idea with one tap, right next to the details chevron. Undo is available only while the toast shows.
- The floating "+" button (New plan) sits over the × and chevron of the bottom row.

**Recommendation (S–M)**
- Make idea rows single-line, with the name, its details and the heart.
- Move "We did it" and "Plan it" into the details sheet and the "Your pick" card, where they already make sense.
- Put remove behind Select or in the sheet's Delete.
- This halves the row height and removes the accidental-delete target.

### L-12 (Medium): the cross-list views and Waiting on you get swamped at scale

**What I saw**
- "Due this week" showed 137 items in one flat list (`scale-desk-due.png`). It starts with tasks overdue since Oct 5, with no grouping by Overdue, Today or day.
- "On me" showed 276 items.
- Neither view has quick add.
- Waiting on you went from 2 to **62**, one entry per overdue item (`scale-phone-inbox.png`). A real question from Alex ("Dinner at my parents'?") sits in a long run of chores.

**Recommendation (M)**
- Group "Due this week" by Overdue, Today and then each day.
- In Waiting on you, fold overdue items into one entry per list ("12 overdue on House projects").
- **Later:** let a couple save their own view (lists, who, due window, hearts), like Reminders smart lists or Todoist filters. It's all computed locally.

### L-13 (Medium): a long note makes the page scroll sideways on a phone

**What I saw.** In a list with Notes on, one item with a 75-character note made the note 442 px wide in a 390 px viewport. The document's `scrollWidth` became 493 px, so the whole page pans sideways, and the note runs past the assignee and details buttons instead of ending in "…" (`scale-phone-todo-scrolled.png`).

**Cause.** `.it-t` is a flex child of `.chk` with the default `min-width: auto`, and `.it-note` is `white-space: nowrap`. The note's full width therefore stretches the row.

**Recommendation (S).** Use `.it-t { flex: 1; min-width: 0; }`, which makes the existing ellipsis work. Add a Playwright check that `scrollWidth <= innerWidth` on Lists with a long note.

### L-14 (Medium): sort keys grow without limit and can tie

**What I saw**
- **Keys grow.** Each new item gets `keyBetween(null, first)`, which halves the first key. I simulated this with the same `midpoint` as `sortkey.ts`, starting from a typical key:

  | Adds to the top | Key length |
  |---|---|
  | 100 | 17 characters |
  | 500 | 84 characters |
  | 1,000 | 167 characters |
  | **~1,200** | **over the 200-character limit** |

  At that point `isSortKey` fails, `put()` throws in `encodeRecord`, and adding to that list stops working with no message. This applies to any list where the newest item isn't deleted, such as an ideas list or a staples list kept with "Start over". The long keys are also stored, and encrypted, in every record.
- **Keys can tie.** When both partners add an item at the same time on different devices, both compute the same key. The sort comparator `a < b ? -1 : 1` never returns 0 and has no tie-breaker, so the two devices can show different orders.

**Recommendation (S–M)**
- When a new key would be longer than about 12 characters, renumber the list with `keysBetween(null, null, n)` in one `bulk()`, which needs one write per item. Or add at the end of the list or section, which also helps L-7, and renumber the same way when needed.
- Tie-break the comparator on `id`.
- Add a little randomness to the last digit of new keys so concurrent adds don't collide.

### L-15 (Low): a pressed chip's count is unreadable

**What I saw.** On a pressed cross-list chip ("Due this week 137"), the count is `--muted` (#5a676a) on `--ours` (#6c5790), about **1.1:1** (`crop-due-chip.png`). WCAG 1.4.3 asks for 4.5:1. The rule is `.xviews .chip .n { color: var(--muted) }`, and it wins over the pressed colour.

**Recommendation (S).** Use `.chip[aria-pressed="true"] .n { color: inherit; opacity: .8 }`, as `.ltab[aria-pressed="true"] .n` already does. Check dark mode the same way.

### L-16 (Low): no keyboard workflow for lists on desktop

**What I saw**
- On Lists, "n" opens **New plan**, and the floating "+" on a phone is New plan as well. Neither adds to the list on screen.
- There's no shortcut to focus the add box, move between items, tick, open details or move an item.
- Every row has three tab stops (L-4).
- Tapping or clicking an item's name ticks it, because the label wraps the text. That's right for groceries, but it means editing is only possible through the small chevron.

**Recommendation (M)**
- On Lists, make "n" or "a" focus the add box, and keep "N"/⇧N for a plan.
- Make each section one tab stop, with ↑/↓ to move between items (a roving tabindex).
- Inside the list: Space or "x" ticks, Enter or "e" opens details, "m" moves, and Alt+↑/↓ reorders.
- Make the floating button on Lists "Add to *list*". Todoist and Things set the bar here.

## Best-in-class gaps

Features worth adding, most valuable first. Each one runs on the device, so all of them work with end-to-end encryption, offline use and a small bundle.

| # | Feature | Who does it well | Why it matters for a couple | Effort |
|---|---|---|---|---|
| 1 | **Move items between lists, and reorder items and lists** (L-2, L-3) | Reminders, Todoist, Things, AnyList | The most basic list edits | M |
| 2 | **A list switcher with pin and archive**, trip checklists retiring themselves (L-1, L-2) | Reminders, To Do, Todoist | Dozens of lists stay manageable | M |
| 3 | **Grocery smarts:** suggestions from past items, bringing back done items, learned aisles, quantity and "@name" parsing (L-7, L-8) | AnyList, OurGroceries, Bring!, Keep | The weekly shop becomes a minute's work | M |
| 4 | **Sort and group per list, and saved views** (L-4, L-12) | Reminders smart lists, Todoist filters, Things Today | "What's next" on long to-do and chore lists | M |
| 5 | **Undo on every tick, and done items newest first** (L-6) | Things logbook, Todoist | Mis-ticks on shared lists | S |
| 6 | **Templates with items, and "copy the last trip's checklist"** (L-9) | Todoist templates, AnyList | Packing, hosting, moving house | M |
| 7 | **Idea → plan → memory linked** (L-10) | none, which makes this a chance to stand out | The app's own core loop | M |
| 8 | **Swipe actions on a phone** (swipe to tick, assign or move), always with buttons as well | Reminders, Todoist, To Do | Fast one-handed use in a shop | M |
| 9 | **Desktop shortcuts and keyboard navigation inside lists** (L-16) | Todoist, Things | Planning sessions at a laptop | M |
| 10 | **Steps inside an item** (a short checklist on one item, such as "Plan anniversary") | Things checklists, Todoist subtasks | Bigger shared tasks without new lists | M–L |
| 11 | **A light "who did it" line** ("Alex ticked 5 things on Big shop") using the envelope's `by`, which is already stored | AnyList, Cozi | Knowing the other person has the shopping in hand | S–M |
| 12 | **Nudges for due items** (I found no notification for item due dates; they only show in Waiting on you), using the existing push and local scheduling | Reminders, Todoist | Chores and admin that are due on a date | M |
| 13 | **Share a list as plain text** (send the grocery list to a parent or a friend, with a clear warning that the copy leaves the encryption) | Keep, Reminders | Occasional help from people outside the couple | S |
| 14 | **Photos on items** (a gift, a product to buy), as encrypted blobs | Keep, AnyList | Gifts and shopping | L |

I would not add location-based reminders or any server-side features. They don't fit the privacy model, and the gains are small for two people.

## Suggested roadmap

**Now (small, mostly CSS and local logic, about one or two days):**
- L-1 S: list title heading, scroll the selected pill into view, a shorter placeholder
- L-2 S: let the desktop sidebar scroll
- L-13: stop the sideways page scroll from long notes
- L-15: chip count contrast
- L-6 S: undo on every tick
- L-14 S: tie-break the comparator on `id`, and renumber keys when they get long
- L-5: index items by list, one pass for the cross-list views, selection read only in rows; plus `content-visibility` on rows (L-4)
- Add a Playwright benchmark with the 2,000-item data set to CI

**Next (the features that make it scale, about two or three weeks):**
- Move to another list, and reorder with keyboard and pointer alternatives (L-3)
- List schema v2 with `sort_key`, `archived`, `pinned` and an ordered `sections` list, rolled out so that older partner devices handle it (L-2, L-7)
- A list switcher on phones with pinned, shared, private, trips and archived groups, and auto-archive offers for past trip checklists (L-1, L-2)
- Sort and group by due date on to-do and chore lists, a sticky add box, and find within a list (L-4)
- Grocery suggestions, bringing back done items, quantity and "@name" parsing (L-8)
- Grouping in the cross-list views and Waiting on you (L-12)
- Compact idea rows (L-11)

**Later:**
- Templates with items, "copy last trip's checklist", attaching an existing list to a plan (L-9)
- Idea → plan → memory linking (L-10)
- Saved views; swipe actions; desktop keyboard workflow (L-16)
- Learned aisles
- Steps inside an item; "who did it" line; due-item nudges; share as text; photos on items
