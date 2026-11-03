# Calendar views: agenda, week and month

Status: implemented with this design (2026-11-03). Owner feedback welcome; this is the reasoning to argue with.

## What each view is for

People open a shared planner with three different questions. One view per question works better than one view that half-answers all three.

| Question | View | Shape |
|---|---|---|
| "What's next, and does anything need me?" | **Agenda** (default, unchanged) | Today onward as a list, proposals that need an answer on top, countdowns, "both free" prompts |
| "How does this week look for the two of us? When are we both free?" | **Week** | Seven days side by side, by time of day |
| "What's coming up this month? When's the trip? Which weekends are free?" | **Month** | A month grid with markers, then the chosen day's plans |

Agenda stays the default because the app's main job is "what's next and what needs an answer", and because it is the most accessible view: the grids are summaries, and everything in them is also in a list.

## Switching and moving around

- A segmented control under the heading: **Agenda · Week · Month**. It is a set of tabs, not a menu, so the current view is always visible and one tap away. The choice is remembered on the device.
- The address follows the view (`#plan`, `#plan/week`, `#plan/month`), so the back button and links behave.
- Week and month have the same navigation in the same place: **‹ previous**, **Today**, **next ›**, with the period as the heading ("3 – 9 Nov", "November 2026"). Today is always one tap away so nobody gets lost in the past.
- Switching views keeps the date you were looking at: the week containing the selected day, the month containing it.
- The week starts on the day set in shared settings, or Monday by default (Sunday where the locale's weeks start on Sunday, e.g. en-US).

## Week view

**Wide screens (720 px and up):** a time grid. Columns are days; rows are hours from 7:00 to 23:00, extended automatically if a plan starts earlier or ends later. All-day plans, away days and trips sit in a row above the grid. Plans are blocks positioned by time; up to three overlapping plans share a column side by side, and more show as "+2". The evening window used for "both free" (17:00–22:00) is shaded on days when both are free, labelled in words.

**Phones:** a time grid of seven columns is too small to read or tap. Instead: a row of seven day buttons (day, date, and up to three markers), and below it the chosen day as a timeline list (the same rows as Agenda). Tapping a day button or swiping changes the day; buttons for previous and next week sit at the ends.

Tapping a plan opens it. Tapping empty time (wide screens) or "Add a plan" (phones) opens quick add with that day and time filled in.

## Month view

A grid of weeks (5 or 6 rows). Each day shows its date and up to three markers; more show as "+2". Plans and their markers use the same visual language as everywhere else, so no new legend is needed:

- **whose**: circle (you), square (partner), both shapes (together), and words in the accessible label;
- **tentative**: dashed outline;
- **private ("Busy")**: hatched;
- **away or trip**: a bar along the bottom of each day it covers;
- **countdown day**: a small flag;
- **both free in the evening**: a hollow ring, labelled in words for screen readers.

On wide screens the cells also show up to two titles. On phones they don't: titles in a 46 px cell would be unreadable, and markers are enough to scan for busy and free days. The chosen day's plans appear below the grid (beside it on very wide screens), with "Add a plan on this day".

## Human factors and accessibility

- **Never colour alone.** Every marker has a shape and every day has a text label (WCAG 1.4.1); the colour-blind simulations in CI cover the new markers.
- **Targets of at least 44 px.** On a 360 px phone a month cell is about 46 px wide. Markers are inside the cell's target, never their own tiny buttons.
- **Keyboard.** The grids are ARIA grids with one tab stop: arrow keys move by day (and by week vertically), Page Up/Down by month or week, Home/End to the week's ends, Enter or Space chooses a day. Focus is always visible.
- **Screen readers.** Each day is announced as, for example, "Tuesday 5 November, 3 plans, both free this evening". Plans inside are reached through the chosen day's list, which is the same list as Agenda.
- **No surprises.** No motion beyond what reduced-motion allows; swiping is a shortcut, never the only way.
- **Consistency.** The same rows, sheets and quick add everywhere, so nothing has to be learnt twice.
- **Proposals don't hide.** If something needs your answer, Week and Month show a one-line notice linking to it.

## Not now

Day view on wide screens, drag to move or resize plans, multi-week custom ranges, and printing. Each is a reasonable follow-up once the basics are in use.

## Testing

E2E: switch views (and back button), move between weeks and months and back to today, choose a day and see its plans, add from a day, keyboard navigation in the month grid; axe on each view in light and dark; no sideways scrolling at 360 px.
