# 0007. Time representation

- Status: Accepted
- Date: 2026-11-03

## Decision
- Timed events: `start`/`end` as wall-clock `YYYY-MM-DDTHH:mm` plus an IANA `tz` (validated with `Intl`). Instants are derived on device.
- All-day events: floating dates `YYYY-MM-DD`, `end` exclusive, `tz` null; they show on the same date for every viewer.
- Recurrence: bare RRULE values (no DTSTART/TZID), expanded with `rrule` on floating dates in the event's wall-clock time, then converted with the event zone — so recurring events keep their local time across DST. Allowed parts: FREQ (daily or slower), INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS, WKST. Expansion is capped at 1000 occurrences.
- Display: viewer's zone; show the original zone when its UTC offset differs at that instant.
- Times inside DST gaps resolve forward (02:30 → 03:30).
- Events and busy stubs carry `away` (from the prototype): an all-day absence that blocks shared free evenings.

## Consequences
Exceptions to recurring events (EXDATE, edited single occurrences) are not yet modelled; add them as new optional fields with a schema bump when needed.
