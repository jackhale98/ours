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

export interface Schedulable {
  start: string;
  end: string;
  all_day: boolean;
  tz: string | null;
  rrule: string | null;
}

export interface Occurrence {
  /** Instants (ms). For all-day events, midnight in the viewer's zone. */
  start: number;
  end: number;
  /** Wall-clock start in the event's zone (or the date for all-day events). */
  localStart: string;
  /** 0 for the first occurrence. Stable while the rule is unchanged. */
  index: number;
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

/** Accepts a bare RRULE value such as "FREQ=WEEKLY;BYDAY=SA". No DTSTART or TZID. */
export function isValidRRule(rule: string): boolean {
  if (rule.length > 500) return false;
  const parts = rule.split(';').map((p) => p.split('='));
  if (!parts.every((p) => p.length === 2 && ALLOWED_RULE_PARTS.has(p[0] ?? ''))) return false;
  if (!parts.some((p) => p[0] === 'FREQ')) return false;
  try {
    const opts = RRule.parseString(rule);
    return opts.freq !== undefined && opts.freq >= RRule.YEARLY && opts.freq <= RRule.DAILY;
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

/** Hard cap so a pathological rule cannot hang the UI. */
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
  const all = rule.all((d, i) => i < MAX_OCCURRENCES && d.getTime() < to + pad);
  const lower = from - pad;
  const out: Occurrence[] = [];
  all.forEach((d, i) => {
    if (d.getTime() < lower) return;
    const o = make(fromFloating(d), i);
    if (overlaps(o) || (o.start === o.end && o.start >= from && o.start < to)) out.push(o);
  });
  return out;
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
