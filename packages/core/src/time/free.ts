// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Free-time finder: intervals when both partners are free within windows
 * (for example, weekday evenings), for "both free this evening" prompts.
 */
import { addDays, toInstant } from './zones';

export interface Interval {
  start: number;
  end: number;
}

/** Sorts and merges overlapping or touching intervals. Drops empty ones. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** Parts of `window` not covered by `busy`. */
export function freeWithin(window: Interval, busy: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let cursor = window.start;
  for (const b of mergeIntervals(busy)) {
    if (b.end <= cursor) continue;
    if (b.start >= window.end) break;
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) out.push({ start: cursor, end: window.end });
  return out;
}

/** Slots of at least `minMinutes` inside any window where nobody is busy. */
export function commonFree(
  windows: readonly Interval[],
  busyByPerson: readonly (readonly Interval[])[],
  minMinutes: number,
): Interval[] {
  const allBusy = busyByPerson.flat();
  return mergeIntervals(windows)
    .flatMap((w) => freeWithin(w, allBusy))
    .filter((s) => s.end - s.start >= minMinutes * 60_000);
}

/** Daily windows such as 17:00–22:00 for `days` days starting at `fromDate`, in `tz`. */
export function dailyWindows(
  fromDate: string,
  days: number,
  tz: string,
  startHHmm: string,
  endHHmm: string,
): Interval[] {
  const out: Interval[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    const endDate = endHHmm <= startHHmm ? addDays(date, 1) : date;
    out.push({
      start: toInstant(`${date}T${startHHmm}`, tz),
      end: toInstant(`${endDate}T${endHHmm}`, tz),
    });
  }
  return out;
}
