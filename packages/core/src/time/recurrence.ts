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
import { RRule } from 'rrule';
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
function feasible(opts: Partial<import('rrule').Options>): boolean {
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
  try {
    const opts = RRule.parseString(rule);
    return (
      opts.freq !== undefined &&
      opts.freq >= RRule.YEARLY &&
      opts.freq <= RRule.DAILY &&
      (opts.interval ?? 1) >= 1 &&
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

  const rule = new RRule({ ...RRule.parseString(event.rrule), dtstart: floating(startWall) });
  // Search a floating window wide enough to cover any zone offset (±14 h)
  // and occurrences that start before `from` but are still running.
  const pad = 15 * 60 * 60_000 + duration * 60_000;
  // Only the window is collected (rrule still counts COUNT from the first
  // date), so a long-running series isn't cut off by the cap (review 0004, L5).
  const all = rule.between(
    new Date(from - pad),
    new Date(to + pad),
    true,
    (_d, i) => i < MAX_OCCURRENCES,
  );
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
