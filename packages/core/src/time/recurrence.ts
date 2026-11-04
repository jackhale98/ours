// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Expands events (optionally recurring, RFC 5545 RRULE) into concrete
 * occurrences within a range, on device.
 *
 * Expansion happens in the event's own wall-clock time, so "every Saturday
 * at 09:00 Europe/London" stays at 09:00 local across daylight-saving
 * changes. rrule is given "floating" dates (UTC fields holding wall-clock
 * values) and every result is converted back with the event's zone.
 * All-day events are floating dates and land on the same calendar date for
 * every viewer.
 */
import { type Options, RRule } from 'rrule';
import {
  addDays,
  addWallMinutes,
  dateIn,
  formatWall,
  parseWall,
  toInstant,
  wallMinutes,
} from './zones';

/** One day of a series changed on its own: skipped (`to: null`) or moved. */
export interface SeriesException {
  /** That day's original start: a date (all-day) or wall-clock date and time. */
  at: string;
  to: { start: string; end: string } | null;
}

export interface Schedulable {
  start: string;
  end: string;
  all_day: boolean;
  tz: string | null;
  rrule: string | null;
  except?: SeriesException[] | undefined;
}

export interface Occurrence {
  /** Instants (ms). For all-day events, midnight in the viewer's zone. */
  start: number;
  end: number;
  /** Wall-clock start in the event's zone (or the date for all-day events). */
  localStart: string;
  /**
   * Stable id of this occurrence within its series: its wall-clock start as
   * minutes since 1970 (floating). Unique per occurrence, and computed without
   * walking the series from its first date.
   */
  index: number;
  /** For a moved day: its original start (same form as `localStart`). */
  movedFrom?: string;
}

const ALLOWED_RULE_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
]);

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Whether a rule can ever produce a date. rrule.js walks day by day to the
 * year 9999 looking for a match, so an impossible rule (e.g. the 30th of
 * February) would freeze the app (security review 0004, M1). With the parts
 * allowed above, impossibility comes from month days that no allowed month
 * has, or ordinal weekdays combined with month days.
 */
function feasible(opts: Partial<Options>): boolean {
  const months = (
    Array.isArray(opts.bymonth) ? opts.bymonth : opts.bymonth ? [opts.bymonth] : []
  ).map(Number);
  const longest = months.length ? Math.max(...months.map((m) => MONTH_DAYS[m - 1] ?? 0)) : 31;
  const days = Array.isArray(opts.bymonthday)
    ? opts.bymonthday
    : opts.bymonthday !== undefined && opts.bymonthday !== null
      ? [opts.bymonthday]
      : [];
  if (days.length && !days.some((d) => d !== 0 && Math.abs(d) <= longest)) return false;
  const weekdays = Array.isArray(opts.byweekday)
    ? opts.byweekday
    : opts.byweekday !== undefined && opts.byweekday !== null
      ? [opts.byweekday]
      : [];
  const ordinal = weekdays.some((w) => typeof w === 'object' && w !== null && 'n' in w && !!w.n);
  if (ordinal && days.length) return false;
  // BYSETPOS picks the nth candidate in each period. Allowed only where every
  // period is sure to have that many candidates (e.g. "last Monday": -1).
  const setpos = Array.isArray(opts.bysetpos)
    ? opts.bysetpos
    : opts.bysetpos !== undefined && opts.bysetpos !== null
      ? [opts.bysetpos]
      : [];
  if (setpos.length) {
    if (days.length || ordinal) return false;
    const perWeek = Math.max(1, weekdays.length);
    const nMonths = Math.max(1, months.length);
    const candidates =
      opts.freq === RRule.WEEKLY
        ? weekdays.length || 1
        : opts.freq === RRule.MONTHLY
          ? weekdays.length
            ? 4 * perWeek
            : 28
          : opts.freq === RRule.YEARLY
            ? weekdays.length
              ? (months.length ? 4 * nMonths : 52) * perWeek
              : months.length
                ? 28 * nMonths
                : 365
            : 1;
    if (!setpos.every((p) => p !== 0 && Math.abs(p) <= candidates)) return false;
  }
  return true;
}

/** Accepts a bare RRULE value such as "FREQ=WEEKLY;BYDAY=SA". No DTSTART or TZID. */
export function isValidRRule(rule: string): boolean {
  if (rule.length > 500) return false;
  const parts = rule.split(';').map((p) => p.split('='));
  if (!parts.every((p) => p.length === 2 && ALLOWED_RULE_PARTS.has(p[0] ?? ''))) return false;
  if (!parts.some((p) => p[0] === 'FREQ')) return false;
  // Lists longer than any real rule needs only add work per period (N1).
  for (const [k, v] of parts) {
    const n = (v ?? '').split(',').length;
    if (n > (MAX_LIST[k ?? ''] ?? Number.POSITIVE_INFINITY)) return false;
  }
  try {
    const opts = RRule.parseString(rule);
    return (
      opts.freq !== undefined &&
      opts.freq >= RRule.YEARLY &&
      opts.freq <= RRule.DAILY &&
      (opts.interval ?? 1) >= 1 &&
      (opts.interval ?? 1) <= MAX_INTERVAL &&
      feasible(opts)
    );
  } catch {
    return false;
  }
}

function floating(local: string): Date {
  const w = parseWall(local);
  return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute));
}

function fromFloating(d: Date): string {
  return formatWall({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  });
}

/** Most occurrences returned for one window. */
export const MAX_OCCURRENCES = 1000;

/** Largest INTERVAL accepted ("every 1000 weeks" is already far beyond use). */
const MAX_INTERVAL = 1000;

/** Most values a BY part may list (review 0004 re-check, N1). */
const MAX_LIST: Record<string, number> = { BYSETPOS: 7, BYDAY: 14, BYMONTHDAY: 31, BYMONTH: 12 };

/**
 * A COUNT above this is treated as this many: longer series are cut short
 * (review 0004 re-check, N1 and N3). Five thousand days is over 13 years.
 */
export const MAX_COUNT = 5000;

/* ---------- bounded work (security review 0004, condition B) ----------
 *
 * rrule.js walks a series period by period from DTSTART, and stops only when
 * it meets a date past the end of what was asked for. Two kinds of rule make
 * that walk long: an old start (a daily series from the year 1000 walks a
 * million days to reach today) and a rule whose filters never line up with
 * its steps (every 7th day, on Tuesdays, from a Monday): it never meets a
 * date at all, so it walks to the year 9999. Both are handled here:
 *   - the start is moved forward by whole periods to just before the window,
 *     with any parts rrule would take from the start written out, so the
 *     dates are the same;
 *   - a COUNT is turned into an UNTIL once (and remembered), so that series
 *     can be moved forward too;
 *   - every walk has a budget of periods: enough to cover the window, after
 *     which it is stopped. A rule that finds nothing in the window costs the
 *     window and no more.
 */

/** Shortest length of one period, in ms (months as 28 days, years as 365). */
const DAY = 86_400_000;
const MIN_PERIOD: Record<number, number> = {
  [RRule.YEARLY]: 365 * DAY,
  [RRule.MONTHLY]: 28 * DAY,
  [RRule.WEEKLY]: 7 * DAY,
  [RRule.DAILY]: DAY,
};
/**
 * Periods walked, at most, to find where a COUNT series ends: about 27
 * years of days, 100 of weeks, 200 of months, 400 of years. Longer periods
 * hold more candidate dates each, so they get fewer (N1).
 */
const COUNT_BUDGET: Record<number, number> = {
  [RRule.YEARLY]: 400,
  [RRule.MONTHLY]: 2400,
  [RRule.WEEKLY]: 5200,
  [RRule.DAILY]: 10_000,
};

const OVER_BUDGET = new Error('recurrence work budget spent');

/**
 * Stop the rule's walk after `periods` periods. rrule.js reads `interval`
 * from its options twice per period (once to check for zero, once to step),
 * which is the one hook it offers into its loop; the tests pin this down.
 */
function limitWork(rule: RRule, periods: number): void {
  const o = rule.options as { interval: number };
  const interval = o.interval;
  let reads = 0;
  const limit = 2 * Math.max(1, Math.ceil(periods)) + 2;
  Object.defineProperty(o, 'interval', {
    configurable: true,
    enumerable: true,
    get() {
      if (++reads > limit) throw OVER_BUDGET;
      return interval;
    },
  });
}

/** Collect dates from a walk, keeping what was found if the budget runs out. */
function walk(rule: RRule, periods: number, run: (keep: (d: Date) => boolean) => void): Date[] {
  limitWork(rule, periods);
  const out: Date[] = [];
  try {
    run((d) => {
      out.push(d);
      return out.length < MAX_OCCURRENCES;
    });
  } catch (e) {
    if (e !== OVER_BUDGET) throw e;
  }
  return out;
}

const weekdayOf = (d: Date) => (d.getUTCDay() + 6) % 7; // rrule: Monday = 0

/** Write out the parts rrule would otherwise take from DTSTART (as rrule does). */
function explicitParts(opts: Partial<Options>, start: Date): Partial<Options> {
  const has = (v: unknown) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length);
  if (has(opts.bymonthday) || has(opts.byweekday)) return opts;
  switch (opts.freq) {
    case RRule.WEEKLY:
      return { ...opts, byweekday: [weekdayOf(start)] };
    case RRule.MONTHLY:
      return { ...opts, bymonthday: [start.getUTCDate()] };
    case RRule.YEARLY:
      return {
        ...opts,
        bymonth: has(opts.bymonth) ? (opts.bymonth ?? null) : [start.getUTCMonth() + 1],
        bymonthday: [start.getUTCDate()],
      };
    default:
      return opts;
  }
}

/**
 * The latest start, on a period boundary of the series and at its time of
 * day, that is at least two periods before `before`; or the start itself.
 */
function movedStart(opts: Partial<Options>, start: Date, before: number): Date {
  const n = opts.interval ?? 1;
  // Time of day; before 1970 `%` is negative, so bring it into [0, DAY) (N2).
  const time = ((start.getTime() % DAY) + DAY) % DAY;
  const atTime = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d) + time);
  switch (opts.freq) {
    case RRule.DAILY:
    case RRule.WEEKLY: {
      const weekly = opts.freq === RRule.WEEKLY;
      const wkst = typeof opts.wkst === 'number' ? opts.wkst : (opts.wkst?.weekday ?? 0);
      const back = weekly ? ((weekdayOf(start) - wkst + 7) % 7) * DAY : 0;
      const first = start.getTime() - back;
      const step = n * (weekly ? 7 : 1) * DAY;
      const k = Math.floor((before - first) / step) - 2;
      return k >= 1 ? new Date(first + k * step) : start;
    }
    case RRule.MONTHLY: {
      const months = start.getUTCFullYear() * 12 + start.getUTCMonth();
      const b = new Date(before);
      const k = Math.floor((b.getUTCFullYear() * 12 + b.getUTCMonth() - months) / n) - 2;
      if (k < 1) return start;
      const m = months + k * n;
      return atTime(Math.floor(m / 12), m % 12, 1);
    }
    case RRule.YEARLY: {
      const k = Math.floor((new Date(before).getUTCFullYear() - start.getUTCFullYear()) / n) - 2;
      return k >= 1 ? atTime(start.getUTCFullYear() + k * n, 0, 1) : start;
    }
    default:
      return start;
  }
}

/** Where a COUNT series ends (its last date), or null if it has none. */
const countEnds = new Map<string, Date | null>();

function countEnd(opts: Partial<Options>, start: Date, key: string): Date | null {
  const known = countEnds.get(key);
  if (known !== undefined) return known;
  const rule = new RRule({ ...opts, dtstart: start }, true);
  let last: Date | null = null;
  limitWork(rule, COUNT_BUDGET[opts.freq ?? RRule.DAILY] ?? 400);
  try {
    rule.all((d) => {
      last = d;
      return true;
    });
  } catch (e) {
    if (e !== OVER_BUDGET) throw e;
  }
  if (countEnds.size >= 500) countEnds.delete(countEnds.keys().next().value as string);
  countEnds.set(key, last);
  return last;
}

/** A valid rule's dates (floating) in [after, before], with bounded work. */
function windowDates(rrule: string, startWall: string, after: number, before: number): Date[] {
  const start = floating(startWall);
  let opts: Partial<Options> = RRule.parseString(rrule);
  if (opts.count) {
    opts = { ...opts, count: Math.min(opts.count, MAX_COUNT) };
    const end = countEnd(opts, start, `${rrule}\u0000${startWall}`);
    if (!end) return [];
    const { count: _drop, ...rest } = opts;
    const until = opts.until && opts.until < end ? opts.until : end;
    opts = { ...rest, until };
  }
  if (opts.until && opts.until.getTime() < after) return [];
  opts = explicitParts(opts, start);
  const dtstart = movedStart(opts, start, after);
  const rule = new RRule({ ...opts, dtstart }, true);
  const period = (MIN_PERIOD[opts.freq ?? RRule.DAILY] ?? DAY) * (opts.interval ?? 1);
  const periods = (before - Math.min(dtstart.getTime(), after)) / period + 4;
  return walk(rule, periods, (keep) => {
    rule.between(new Date(after), new Date(before), true, keep);
  });
}

/**
 * Occurrences overlapping [from, to). `viewerTz` places all-day events.
 */
export function expand(
  event: Schedulable,
  from: number,
  to: number,
  viewerTz: string,
): Occurrence[] {
  const zone = event.all_day ? viewerTz : event.tz;
  if (!zone) throw new RangeError('Timed events need a time zone');
  const startWall = event.all_day ? `${event.start}T00:00` : event.start;
  const endWall = event.all_day ? `${event.end}T00:00` : event.end;
  const duration = wallMinutes(startWall, endWall);

  const make = (localStart: string, index: number): Occurrence => ({
    start: toInstant(localStart, zone),
    end: toInstant(addWallMinutes(localStart, duration), zone),
    localStart: event.all_day ? localStart.slice(0, 10) : localStart,
    index,
  });
  const overlaps = (o: Occurrence) => o.end > from && o.start < to && o.end >= o.start;

  if (!event.rrule) {
    const only = make(startWall, 0);
    // Zero-length events (e.g. a reminder at 9:00) count if they start in range.
    const hit = only.start === only.end ? only.start >= from && only.start < to : overlaps(only);
    return hit ? [only] : [];
  }
  if (!isValidRRule(event.rrule)) return [];

  // Search a floating window wide enough to cover any zone offset (±14 h)
  // and occurrences that start before `from` but are still running.
  const pad = 15 * 60 * 60_000 + duration * 60_000;
  const all = windowDates(event.rrule, startWall, from - pad, to + pad);
  const inRange = (o: Occurrence) =>
    overlaps(o) || (o.start === o.end && o.start >= from && o.start < to);
  // Days changed on their own: skipped ones drop out, moved ones drop out
  // here and come back at their new times below (with the same index, so
  // the day keeps its identity for reminders and keys).
  const except = new Map<string, SeriesException>();
  for (const x of event.except ?? []) except.set(event.all_day ? x.at : x.at.slice(0, 16), x);
  const out: Occurrence[] = [];
  all.forEach((d) => {
    const local = fromFloating(d);
    if (except.has(event.all_day ? local.slice(0, 10) : local)) return;
    const o = make(local, Math.floor(d.getTime() / 60_000));
    if (inRange(o)) out.push(o);
  });
  for (const x of except.values()) {
    if (!x.to) continue;
    const at = event.all_day ? `${x.at}T00:00` : x.at;
    const s = event.all_day ? `${x.to.start}T00:00` : x.to.start;
    const e = event.all_day ? `${x.to.end}T00:00` : x.to.end;
    const o: Occurrence = {
      start: toInstant(s, zone),
      end: toInstant(e, zone),
      localStart: event.all_day ? x.to.start : x.to.start,
      index: Math.floor(floating(at).getTime() / 60_000),
      movedFrom: x.at,
    };
    if (o.end >= o.start && inRange(o)) out.push(o);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Calendar dates an occurrence touches in `tz` (for placing it in a day list). */
export function daysTouched(o: Occurrence, tz: string): string[] {
  const first = dateIn(o.start, tz);
  const last = dateIn(Math.max(o.start, o.end - 1), tz);
  const days = [first];
  while ((days[days.length - 1] ?? last) < last && days.length < 366) {
    days.push(addDays(days[days.length - 1] ?? first, 1));
  }
  return days;
}

/**
 * The next date a repeating task is due after it is done (dates only,
 * 'YYYY-MM-DD'). Counted from its current due date when that is still ahead
 * (done early), otherwise from today, so an overdue task doesn't come back
 * already overdue. Null if the rule has no further dates.
 */
export function nextDueDate(rrule: string, due: string | null, today: string): string | null {
  if (!isValidRRule(rrule)) return null;
  const anchor = due ?? today;
  const after = due && due > today ? due : today;
  const afterInstant = Date.parse(`${after}T00:00:00Z`) + 86_400_000;
  const occ = expand(
    { start: anchor, end: addDays(anchor, 1), all_day: true, tz: null, rrule },
    afterInstant,
    afterInstant + 2 * 366 * 86_400_000,
    'UTC',
  );
  const first = occ.find((o) => o.localStart > after);
  return first ? first.localStart.slice(0, 10) : null;
}
