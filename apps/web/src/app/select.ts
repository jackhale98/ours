// SPDX-License-Identifier: AGPL-3.0-or-later
/** Derived views over the store: agenda, proposals, countdowns, free evenings. */
import {
  addDays,
  dateIn,
  daysTouched,
  expand,
  freeWithin,
  type Interval,
  type Occurrence,
  toInstant,
  wallMinutes,
  zoneDiffers,
} from '@ours/core/time';
import { computed, signal } from '@preact/signals';
import {
  byKind,
  commentsFor,
  type Entry,
  type EventData,
  partner,
  type Slot,
  settings,
  viewer,
  visible,
} from './model';

/** The viewer's zone. Every date in the UI is a calendar date in this zone. */
export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Re-evaluated at midnight by the shell so "today" stays correct. */
export const now = signal(Date.now());
export const today = computed(() => dateIn(now.value, zone));

export const EVENING = { start: '17:00', end: '22:00' } as const;

/* ---------- formatting ---------- */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const parts = (date: string) => date.split('-').map(Number) as [number, number, number];
export const dow = (date: string) => {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
export const dayNum = (date: string) => parts(date)[2];
export const dowShort = (date: string) => DOW[dow(date)] ?? '';
export const monDay = (date: string) => `${MON[parts(date)[1] - 1]} ${parts(date)[2]}`;
export const fmtLong = (date: string) => `${dowShort(date)}, ${monDay(date)}`;
export const daysFrom = (from: string, to: string) => Math.round(wallMinutes(from, to) / 1440);

export function relDay(date: string, base = today.value): string {
  const n = daysFrom(base, date);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n > 1 && n < 7) return DOW_LONG[dow(date)] ?? '';
  return fmtLong(date);
}

const hour12 = (() => {
  const hc = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return hc !== 'h23' && hc !== 'h24';
})();

/** "7 PM", "7:30 PM" or "19:00" depending on the viewer's locale. */
export function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  if (!hour12) return hhmm;
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${ap}`;
}

/** When a plan happens, including plans over several days. */
export function planWhen(d: { start: string; end: string; all_day: boolean }): string {
  const first = d.start.slice(0, 10);
  if (d.all_day) {
    const last = addDays(d.end.slice(0, 10), -1);
    if (last > first) return `${fmtLong(first)} – ${fmtLong(last)} · All day`;
    return whenText(first, true);
  }
  const lastDay = d.end.slice(0, 10);
  if (lastDay > first) {
    return `${fmtLong(first)}, ${fmtTime(d.start.slice(11))} – ${fmtLong(lastDay)}, ${fmtTime(d.end.slice(11))}`;
  }
  return whenText(first, false, d.start.slice(11), d.end.slice(11));
}

export function whenText(date: string, allDay: boolean, start?: string, end?: string): string {
  const n = daysFrom(today.value, date);
  const day = relDay(date) + (n > 1 && n < 7 ? `, ${monDay(date)}` : '');
  if (allDay) return `${day} · All day`;
  return `${day} · ${start ? fmtTime(start) : ''}${end && end !== start ? ` – ${fmtTime(end)}` : ''}`;
}

const DAY_NAMES: Record<string, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};

/** Short human text for the RRULE subset we create. */
export function repeatText(rrule: string | null): string {
  if (!rrule) return '';
  const p = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=') as [string, string]));
  const ord = (d: number) =>
    `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;
  const on = p.FREQ === 'MONTHLY' && p.BYMONTHDAY ? ` on the ${ord(Number(p.BYMONTHDAY))}` : '';
  // How it ends (review 0009, P-6): "10 times", "until Jan 31".
  const ends = p.COUNT
    ? `, ${p.COUNT} times`
    : p.UNTIL
      ? `, until ${fmtLong(`${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}`)}`
      : '';
  return baseRepeat(p) + on + ends;
}

function baseRepeat(p: Record<string, string>): string {
  const n = Number(p.INTERVAL ?? 1);
  const unit =
    { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[p.FREQ ?? ''] ?? '';
  if (p.FREQ === 'WEEKLY' && p.BYDAY) {
    const days = p.BYDAY.split(',');
    if (days.join(',') === 'MO,TU,WE,TH,FR')
      return n > 1 ? `Every ${n} weeks on weekdays` : 'Every weekday';
    if (days.join(',') === 'SA,SU') return n > 1 ? `Every ${n} weekends` : 'Every weekend';
    const names = days.map((d) => DAY_NAMES[d.replace(/^[+-]?\d+/, '')] ?? d);
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
        : names[0];
    return n === 2
      ? `Every other ${list}`
      : n > 2
        ? `Every ${n} weeks on ${list}`
        : `Every ${list}`;
  }
  return n === 2 && unit === 'week'
    ? 'Every other week'
    : n > 1
      ? `Every ${n} ${unit}s`
      : `Every ${unit}`;
}

/* ---------- imported calendars ---------- */

export type SnapshotEntry = Entry & { rec: { kind: 'cal_snapshot' } };

/**
 * Snapshots to show: for each calendar, the private full copy if this device
 * has it, otherwise the shared copy (which may be busy-only).
 */
export function visibleSnapshots(): SnapshotEntry[] {
  const best = new Map<string, SnapshotEntry>();
  for (const s of byKind('cal_snapshot') as SnapshotEntry[]) {
    const id = s.rec.data.calendar_id;
    const cur = best.get(id);
    if (!cur || (s.scope === 'user' && cur.scope !== 'user')) best.set(id, s);
  }
  return [...best.values()];
}

/* ---------- agenda ---------- */

export interface Row {
  key: string;
  id: string;
  /** 'busy' rows are a partner's private plans: no details. 'import' rows come from an imported calendar. */
  type: 'event' | 'busy' | 'import';
  /** Where it came from: an Ours plan/stub, or an imported calendar. */
  origin: 'plan' | 'import';
  /** Imported calendar name, when known. */
  source: string | null;
  /** For imported rows: who imported the calendar (their own feed leaves it out). */
  importer: Slot | null;
  /** Marked free in its source calendar: shown, but doesn't block time. */
  free: boolean;
  owner: Slot | 'both';
  title: string;
  allDay: boolean;
  away: boolean;
  start: string; // HH:mm in the viewer's zone
  end: string;
  status: 'confirmed' | 'proposed' | 'declined';
  proposedBy: Slot | null;
  location: string | null;
  repeat: string;
  comments: number;
  privacy: 'full' | 'busy';
  /** Original zone label when it shows a different clock time. */
  zoneNote: string | null;
  /** A milestone counted down to on the Plan screen. */
  countdown: boolean;
  occStart: number;
  occEnd: number;
  /**
   * For a repeating plan: this day's original start (the series' own form),
   * which names the day for skipping or moving it on its own.
   */
  occ: string | null;
  /** This day was moved on its own (from `occ`). */
  moved: boolean;
  /** For a plan over several days: which day this is (1-based) and how many. */
  span: { day: number; of: number } | null;
}

/** One row per day a plan touches, each knowing which day of the plan it is (P-11). */
function perDay(o: Occurrence, row: Row): { day: string; row: Row }[] {
  const days = daysTouched(o, zone);
  if (days.length === 1) return [{ day: days[0] as string, row }];
  return days.map((day, i) => ({ day, row: { ...row, span: { day: i + 1, of: days.length } } }));
}

/** One formatter for every row: making one per call was a large share of render time (P-1). */
const HHMM = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
export function hhmm(instant: number): string {
  return HHMM.format(instant);
}

/**
 * Whether a plan's dates could touch [first, end): a cheap check on the date
 * text, with two days' slack for zones, before any zone conversion (P-1).
 */
function nearWindow(start: string, end: string, lo: string, hi: string): boolean {
  return end.slice(0, 10) >= lo && start.slice(0, 10) <= hi;
}

/**
 * Each plan's rows per window, kept with the record itself: a change to one
 * plan recomputes that plan only (P-1). Keyed by window, viewer and the
 * plan's note count, which rows show.
 */
type DayRow = { day: string; row: Row };
const rowCache = new WeakMap<Entry, Map<string, DayRow[]>>();
function cachedRows(entry: Entry, key: string, make: () => DayRow[]): DayRow[] {
  let byKey = rowCache.get(entry);
  if (!byKey) {
    byKey = new Map();
    rowCache.set(entry, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  const rows = make();
  if (byKey.size > 8) byKey.delete(byKey.keys().next().value as string);
  byKey.set(key, rows);
  return rows;
}

function rowsFor(entry: Entry, from: number, to: number): { day: string; row: Row }[] {
  const r = entry.rec;
  if (r.kind !== 'event' && r.kind !== 'busy_stub') return [];
  // A declined proposal stays only with the person who asked, as an answer.
  if (r.kind === 'event' && r.data.status === 'declined' && r.data.proposed_by !== viewer.value)
    return [];
  const d = r.data;
  const occs: Occurrence[] = expand(d, from, to, zone);
  const comments = r.kind === 'event' ? commentsFor(entry.id).length : 0;
  return occs.flatMap((o) => {
    const base: Row = {
      origin: 'plan',
      source: null,
      importer: null,
      free: false,
      key: `${entry.id}:${o.index}`,
      id: entry.id,
      type: r.kind === 'busy_stub' ? 'busy' : 'event',
      owner: r.kind === 'event' ? r.data.owner : r.data.owner,
      title: r.kind === 'event' ? r.data.title : 'Busy',
      allDay: d.all_day,
      away: d.away,
      start: d.all_day ? '' : hhmm(o.start),
      end: d.all_day ? '' : hhmm(o.end),
      status: r.kind === 'event' ? r.data.status : 'confirmed',
      proposedBy: r.kind === 'event' ? r.data.proposed_by : null,
      location: r.kind === 'event' ? r.data.location : null,
      repeat: repeatText(d.rrule),
      comments,
      privacy: r.kind === 'event' ? r.data.privacy : 'busy',
      zoneNote:
        !d.all_day && d.tz && zoneDiffers(d.tz, zone, o.start)
          ? `${o.localStart.slice(11)} ${d.tz.split('/').pop()?.replace(/_/g, ' ')}`
          : null,
      countdown: r.kind === 'event' && r.data.countdown,
      occStart: o.start,
      occEnd: o.end,
      occ: d.rrule ? (o.movedFrom ?? o.localStart) : null,
      moved: !!o.movedFrom,
      span: null,
    };
    return perDay(o, base);
  });
}

function importRows(
  entry: SnapshotEntry,
  from: number,
  to: number,
  lo: string,
  hi: string,
): { day: string; row: Row }[] {
  const d = entry.rec.data;
  return d.items.flatMap((item, i) =>
    (nearWindow(item.start, item.end, lo, hi)
      ? expand({ ...item, rrule: null }, from, to, zone)
      : []
    ).flatMap((o) => {
      const row: Row = {
        origin: 'import',
        importer: d.importer,
        key: `${entry.id}:${i}`,
        id: entry.id,
        type: d.detail === 'busy' ? 'busy' : 'import',
        owner: d.owner,
        title: d.detail === 'busy' ? 'Busy' : item.title || 'Busy',
        allDay: item.all_day,
        away: false,
        start: item.all_day ? '' : hhmm(o.start),
        end: item.all_day ? '' : hhmm(o.end),
        status: 'confirmed',
        proposedBy: null,
        location: d.detail === 'busy' ? null : (item.location ?? null),
        repeat: '',
        comments: 0,
        privacy: 'full',
        zoneNote: null,
        countdown: false,
        occStart: o.start,
        occEnd: o.end,
        occ: null,
        moved: false,
        source: d.name ?? null,
        free: !!item.free,
        span: null,
      };
      return perDay(o, row);
    }),
  );
}

/** A timed plan that began on an earlier day ("Until 12:30 PM"): it comes before the day's own. */
export const continues = (r: Row) => !r.allDay && !!r.span && r.span.day > 1;

const sortRows = (a: Row, b: Row) =>
  Number(b.allDay) - Number(a.allDay) ||
  Number(continues(b)) - Number(continues(a)) ||
  a.start.localeCompare(b.start) ||
  a.title.localeCompare(b.title);

export interface Day {
  date: string;
  rows: Row[];
  bothFree: boolean;
  /** Rows that overlap another for the same person (review 0009, P-3). */
  clash: ReadonlySet<string>;
  /** Who is away all day: their routines that day are dimmed (P-3). */
  away: ReadonlySet<Slot>;
}

/** Whether two rows can clash: they involve the same person. */
const sharesPerson = (a: Row, b: Row) =>
  a.owner === 'both' || b.owner === 'both' || a.owner === b.owner;

/** Each overlapping pair's rows, by key. Days hold a few dozen rows at most. */
function clashesIn(rows: Row[]): Set<string> {
  const timed = rows.filter(blocksTime);
  const out = new Set<string>();
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i] as Row;
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j] as Row;
      if (b.occStart >= a.occEnd) continue;
      if (a.occStart < b.occEnd && sharesPerson(a, b) && a.id !== b.id) {
        out.add(a.key);
        out.add(b.key);
      }
    }
  }
  return out;
}

function awayOn(rows: Row[]): Set<Slot> {
  const out = new Set<Slot>();
  for (const r of rows)
    if (r.allDay && r.away && r.status !== 'declined') {
      if (r.owner === 'both') {
        out.add('a');
        out.add('b');
      } else out.add(r.owner);
    }
  return out;
}

/** A routine on a day its person is away: shown dimmed, it likely isn't happening. */
export function routineWhileAway(row: Row, day: Day): boolean {
  if (!row.repeat || row.allDay || !day.away.size) return false;
  return row.owner === 'both' ? day.away.size === 2 : day.away.has(row.owner);
}

/**
 * What a plan from `start` to `end` (instants) would overlap, for `owner`:
 * timed plans of the same person (or both), their Busy markers and
 * imported calendars. `except` leaves out the plan itself when editing.
 */
export function conflictsFor(
  start: number,
  end: number,
  owner: Slot | 'both',
  except?: string,
): Row[] {
  if (!(end > start)) return [];
  const first = dateIn(start, zone);
  const days = Math.min(14, Math.max(1, Math.round((end - start) / 86_400_000) + 2));
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const d of agendaFrom(first, days)) {
    for (const r of d.rows) {
      if (seen.has(r.key) || r.id === except || !blocksTime(r)) continue;
      if (r.occStart >= end || r.occEnd <= start) continue;
      if (!(owner === 'both' || r.owner === 'both' || r.owner === owner)) continue;
      seen.add(r.key);
      out.push(r);
    }
  }
  return out;
}

/** "Overlaps Book club (yours)", "Alex is busy then", or null. */
export function clashText(rows: Row[], names: { me: Slot; partner: string }): string | null {
  const r = rows[0];
  if (!r) return null;
  const more = rows.length > 1 ? ` and ${rows.length - 1} more` : '';
  if (r.type === 'busy' || (r.origin === 'import' && r.type !== 'import'))
    return r.owner === names.me
      ? `You’re busy then${more}`
      : `${names.partner} is busy then${more}`;
  const whose = r.owner === 'both' ? 'ours' : r.owner === names.me ? 'yours' : `${names.partner}’s`;
  return `Overlaps ${r.title} (${whose})${more}`;
}

/** The last few windows, oldest dropped first (it used to clear all at once). */
const agendaCache = new Map<string, { data: unknown; days: Day[] }>();

/** Days from today. Memoised on the store, viewer and date, so views can share it. */
export function agenda(days: number): Day[] {
  return agendaFrom(today.value, days);
}

/** `days` days starting at `first` (any date: week and month views). Memoised. */
export function agendaFrom(first: string, days: number): Day[] {
  const data = visible.value;
  const key = `${first}|${days}|${today.value}`;
  const hit = agendaCache.get(key);
  if (hit && hit.data === data) {
    // Most recently used last.
    agendaCache.delete(key);
    agendaCache.set(key, hit);
    return hit.days;
  }
  const result = computeAgenda(first, days);
  agendaCache.delete(key);
  agendaCache.set(key, { data, days: result });
  while (agendaCache.size > 24) agendaCache.delete(agendaCache.keys().next().value as string);
  return result;
}

/** Whether this browser's locale writes numeric dates day first (14/11) or month first. */
export const DATE_ORDER: 'MD' | 'DM' = (() => {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' })
      .formatToParts(new Date(2000, 10, 22))
      .map((x) => x.type);
    return parts.indexOf('day') < parts.indexOf('month') ? 'DM' : 'MD';
  } catch {
    return 'MD';
  }
})();

/** When "both free this evening" looks: shared setting, else 5 to 10 PM (P-12). */
export const evening = computed(() => {
  const e = settings.value.evening;
  return e && e.start < e.end ? e : EVENING;
});

/** First day of the week: shared setting, else the locale's convention (Sunday in the US). */
export const weekStartsOn = computed<number>(() => {
  const set = settings.value.week_start;
  if (set !== undefined) return set;
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay;
    if (first) return first % 7; // Intl: 1 = Monday … 7 = Sunday
  } catch {
    // older browsers
  }
  return 1;
});

/** The first day of the week containing `date`. */
export function startOfWeek(date: string, startsOn = weekStartsOn.value): string {
  return addDays(date, -((dow(date) - startsOn + 7) % 7));
}

function computeAgenda(first: string, days: number): Day[] {
  const from = toInstant(`${first}T00:00`, zone);
  const to = toInstant(`${addDays(first, days)}T00:00`, zone);
  const byDay = new Map<string, Row[]>();
  const add = ({ day, row }: { day: string; row: Row }) => {
    const list = byDay.get(day) ?? [];
    list.push(row);
    byDay.set(day, list);
  };
  const endDay = addDays(first, days);
  // The window's dates with two days' slack for zones, worked out once.
  const lo = addDays(first, -2);
  const hi = addDays(endDay, 2);
  const who = viewer.value;
  for (const e of [...byKind('event'), ...byKind('busy_stub')]) {
    if (e.rec.kind !== 'event' && e.rec.kind !== 'busy_stub') continue;
    const d = e.rec.data;
    // Plans that don't repeat and are nowhere near: skipped without any zone work.
    if (!d.rrule && !nearWindow(d.start, d.end, lo, hi)) continue;
    const notes = e.rec.kind === 'event' ? commentsFor(e.id).length : 0;
    cachedRows(e, `${from}|${to}|${who}|${notes}`, () => rowsFor(e, from, to)).forEach(add);
  }
  for (const s of visibleSnapshots())
    cachedRows(s, `${from}|${to}|${first}|${endDay}`, () =>
      importRows(s, from, to, lo, hi),
    ).forEach(add);
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(first, i);
    const rows = (byDay.get(date) ?? []).sort(sortRows);
    return {
      date,
      rows,
      bothFree: isEveningFree(date, rows),
      clash: clashesIn(rows),
      away: awayOn(rows),
    };
  });
}

/** Rows that take up time: timed, not marked free in their calendar, not declined (P-12). */
const blocksTime = (r: Row) => !r.allDay && !r.free && r.status !== 'declined';

/**
 * An evening is "both free" when neither of you has anything between 17:00
 * and 22:00 and nobody is away that day (all-day events that are not
 * "away", like birthdays, don't count).
 */
function isEveningFree(date: string, rows: Row[]): boolean {
  if (rows.some((r) => r.allDay && r.away)) return false;
  const window: Interval = {
    start: toInstant(`${date}T${evening.value.start}`, zone),
    end: toInstant(`${date}T${evening.value.end}`, zone),
  };
  const busy = rows
    .filter(blocksTime)
    .map((r) => ({ start: r.occStart, end: Math.max(r.occEnd, r.occStart + 60_000) }));
  const free = freeWithin(window, busy);
  return free.length === 1 && free[0]?.start === window.start && free[0]?.end === window.end;
}

/** The part of the day we suggest time together in. */
export const DAYTIME = { start: '08:00', end: '22:00' } as const;

/**
 * Stretches of a day when you're both free (between 8 AM and 10 PM, at least
 * an hour long), as instants. Nothing if either of you is away. Today's
 * start from the next half hour.
 */
export function freeStretches(date: string): Interval[] {
  const day = agendaFrom(date, 1)[0];
  if (!day || day.rows.some((r) => r.allDay && r.away)) return [];
  let start = toInstant(`${date}T${DAYTIME.start}`, zone);
  const end = toInstant(`${date}T${DAYTIME.end}`, zone);
  if (date === today.value) {
    const half = 30 * 60_000;
    start = Math.max(start, Math.ceil(now.value / half) * half);
  }
  if (start >= end) return [];
  const busy = day.rows
    .filter(blocksTime)
    .map((r) => ({ start: r.occStart, end: Math.max(r.occEnd, r.occStart + 60_000) }));
  return freeWithin({ start, end }, busy).filter((w) => w.end - w.start >= 60 * 60_000);
}

export function freeEvenings(days: number): string[] {
  return agenda(days)
    .filter((d) => d.bothFree)
    .map((d) => d.date);
}

export function nextFreeEvening(): string {
  return freeEvenings(14)[0] ?? today.value;
}

/* ---------- proposals and countdowns ---------- */

/** Whether a plan's last day is today or later (all-day ends are exclusive). */
export function stillAhead(e: Entry, t: string): boolean {
  if (e.rec.kind !== 'event') return false;
  const d = e.rec.data;
  const last = d.all_day ? addDays(d.end.slice(0, 10), -1) : d.end.slice(0, 10);
  return last >= t;
}

/**
 * The partner's questions still to answer: not ones for dates that have
 * passed (review 0009, P-2; Waiting on you already left those out).
 */
export const awaitingMe = computed(() =>
  byKind('event')
    .filter(
      (e) =>
        e.rec.kind === 'event' &&
        e.rec.data.status === 'proposed' &&
        e.rec.data.proposed_by === partner.value &&
        (!!e.rec.data.rrule || stillAhead(e, today.value)),
    )
    .sort((a, b) =>
      a.rec.kind === 'event' && b.rec.kind === 'event'
        ? a.rec.data.start.localeCompare(b.rec.data.start)
        : 0,
    ),
);

export const countdowns = computed(() => {
  const t = today.value;
  return byKind('event')
    .flatMap((e) => {
      if (e.rec.kind !== 'event' || !e.rec.data.countdown) return [];
      const n = daysFrom(t, e.rec.data.start.slice(0, 10));
      return n >= 0 ? [{ id: e.id, title: e.rec.data.title, days: n }] : [];
    })
    .sort((a, b) => a.days - b.days);
});

export function ownerLabel(owner: Slot | 'both', names: Record<Slot, string>): string {
  if (owner === 'both') return 'Ours';
  if (owner === viewer.value) return 'Yours';
  return `${names[owner]}’s`;
}

/**
 * What changed in a plan's last edit by one of you (review 0009, P-4):
 * "Fri 7:30 PM → Sat 7 PM", "was “Dinner”", "new place". Null if nothing.
 */
export function changeText(d: EventData): string | null {
  const w = d.was;
  if (!w) return null;
  const parts: string[] = [];
  if (w.start && w.end)
    parts.push(
      `${whenText(w.start.slice(0, 10), d.all_day, w.start.slice(11), w.end.slice(11))} → ${whenText(
        d.start.slice(0, 10),
        d.all_day,
        d.start.slice(11),
        d.end.slice(11),
      )}`,
    );
  if (w.title !== undefined) parts.push(`was “${w.title}”`);
  if (w.location !== undefined) parts.push(d.location ? `now at ${d.location}` : 'no place now');
  return parts.length ? parts.join(' · ') : null;
}

/** A proposal that changes the time: a move of a plan you had, or another time suggested. */
export const isMoveAsk = (d: EventData) =>
  d.status === 'proposed' && !!d.was?.start && d.was.by === d.proposed_by;

/** "wants to move this" (a plan you had) or "suggests another time" (an answer to a request). */
export const askVerb = (d: EventData) =>
  !isMoveAsk(d) ? 'asked' : d.was?.confirmed ? 'wants to move this' : 'suggests another time';

/** Days with only the rows the Plan views show (filters in planview.ts). Same days if none. */
export function shownDays(days: Day[], hide: ReadonlySet<string>): Day[] {
  if (!hide.size) return days;
  const me = viewer.value;
  const show = (r: Row) => {
    if (hide.has('routines') && r.repeat) return false;
    if (r.origin === 'import') return !hide.has('imported');
    if (r.owner === 'both') return !hide.has('ours');
    return !hide.has(r.owner === me ? 'mine' : 'partner');
  };
  return days.map((d) => ({ ...d, rows: d.rows.filter(show) }));
}
