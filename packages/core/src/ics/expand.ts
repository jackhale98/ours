// SPDX-License-Identifier: AGPL-3.0-or-later
import { expand, type Occurrence } from '../time/recurrence';
import type { IcsCalendar, IcsEvent } from './parse';

export interface IcsOccurrence {
  uid: string;
  title: string;
  location: string | null;
  start: number;
  end: number;
  all_day: boolean;
  busy: boolean;
  localStart: string;
}

const DEFAULT_MAX = 2000;
const DEFAULT_BUDGET_MS = 1500;

const keyOf = (uid: string, localStart: string) => `${uid}\u0000${localStart}`;

function expandEvent(e: IcsEvent, from: number, to: number, viewerTz: string): Occurrence[] {
  try {
    return expand(
      { start: e.start, end: e.end, all_day: e.all_day, tz: e.tz, rrule: e.rrule },
      from,
      to,
      viewerTz,
    );
  } catch {
    return [];
  }
}

/**
 * Concrete occurrences overlapping [from, to), sorted by start. EXDATEs are
 * removed, RECURRENCE-ID overrides replace (or, if cancelled, remove) the
 * occurrence they name, and the result is capped at `opts.max`.
 */
export function icsOccurrences(
  cal: IcsCalendar,
  from: number,
  to: number,
  viewerTz: string,
  opts: { max?: number; budgetMs?: number } = {},
): IcsOccurrence[] {
  const max = Math.max(0, Math.floor(opts.max ?? DEFAULT_MAX));
  if (max === 0 || !(from < to)) return [];

  const replaced = new Set<string>();
  for (const e of cal.events) {
    if (e.recurrence_id) replaced.add(keyOf(e.uid, e.recurrence_id));
  }

  // Bound the work done for huge feeds; far more than `max` is never needed.
  // Each event's expansion is bounded on its own (see time/recurrence); a
  // deadline bounds a feed with very many of them (review 0004, condition B).
  const workLimit = Math.max(max * 4, 1000);
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const out: IcsOccurrence[] = [];
  for (const e of cal.events) {
    if (out.length >= workLimit || Date.now() > deadline) break;
    if (e.cancelled) continue;
    const isOverride = e.recurrence_id !== null;
    const exdates = new Set(e.exdates.map((x) => x.slice(0, e.all_day ? 10 : 16)));
    const source = isOverride ? { ...e, rrule: null } : e;
    for (const o of expandEvent(source, from, to, viewerTz)) {
      if (!isOverride && (exdates.has(o.localStart) || replaced.has(keyOf(e.uid, o.localStart)))) {
        continue;
      }
      out.push({
        uid: e.uid,
        title: e.title,
        location: e.location,
        start: o.start,
        end: o.end,
        all_day: e.all_day,
        busy: e.busy,
        localStart: o.localStart,
      });
    }
  }
  out.sort(
    (a, b) => a.start - b.start || a.end - b.end || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0),
  );
  return out.slice(0, max);
}
