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
  const n = Number(p.INTERVAL ?? 1);
  const unit =
    { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[p.FREQ ?? ''] ?? '';
  if (p.FREQ === 'WEEKLY' && p.BYDAY && !p.BYDAY.includes(',') && n === 1) {
    return `Every ${DAY_NAMES[p.BYDAY] ?? 'week'}`;
  }
  return n > 1 ? `Every ${n} ${unit}s` : `Every ${unit}`;
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
}

function hhmm(instant: number): string {
  return new Date(instant).toLocaleTimeString('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function rowsFor(entry: Entry, from: number, to: number): { day: string; row: Row }[] {
  const r = entry.rec;
  if (r.kind !== 'event' && r.kind !== 'busy_stub') return [];
  // A declined proposal stays only with the person who asked, as an answer.
  if (r.kind === 'event' && r.data.status === 'declined' && r.data.proposed_by !== viewer.value)
    return [];
  const d = r.data;
  const occs: Occurrence[] = expand(d, from, to, zone);
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
      comments: r.kind === 'event' ? commentsFor(entry.id).length : 0,
      privacy: r.kind === 'event' ? r.data.privacy : 'busy',
      zoneNote:
        !d.all_day && d.tz && zoneDiffers(d.tz, zone, o.start)
          ? `${o.localStart.slice(11)} ${d.tz.split('/').pop()?.replace(/_/g, ' ')}`
          : null,
      countdown: r.kind === 'event' && r.data.countdown,
      occStart: o.start,
      occEnd: o.end,
    };
    return daysTouched(o, zone).map((day) => ({ day, row: base }));
  });
}

function importRows(entry: SnapshotEntry, from: number, to: number): { day: string; row: Row }[] {
  const d = entry.rec.data;
  return d.items.flatMap((item, i) =>
    expand({ ...item, rrule: null }, from, to, zone).flatMap((o) => {
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
        source: d.name ?? null,
        free: !!item.free,
      };
      return daysTouched(o, zone).map((day) => ({ day, row }));
    }),
  );
}

const sortRows = (a: Row, b: Row) =>
  Number(b.allDay) - Number(a.allDay) ||
  a.start.localeCompare(b.start) ||
  a.title.localeCompare(b.title);

export interface Day {
  date: string;
  rows: Row[];
  bothFree: boolean;
}

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
  if (hit && hit.data === data) return hit.days;
  if (agendaCache.size > 12) agendaCache.clear();
  const result = computeAgenda(first, days);
  agendaCache.set(key, { data, days: result });
  return result;
}

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
  for (const e of [...byKind('event'), ...byKind('busy_stub')]) rowsFor(e, from, to).forEach(add);
  for (const s of visibleSnapshots()) importRows(s, from, to).forEach(add);
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(first, i);
    const rows = (byDay.get(date) ?? []).sort(sortRows);
    return { date, rows, bothFree: isEveningFree(date, rows) };
  });
}

/**
 * An evening is "both free" when neither of you has anything between 17:00
 * and 22:00 and nobody is away that day (all-day events that are not
 * "away", like birthdays, don't count).
 */
function isEveningFree(date: string, rows: Row[]): boolean {
  if (rows.some((r) => r.allDay && r.away)) return false;
  const window: Interval = {
    start: toInstant(`${date}T${EVENING.start}`, zone),
    end: toInstant(`${date}T${EVENING.end}`, zone),
  };
  const busy = rows
    .filter((r) => !r.allDay && r.status !== 'declined')
    .map((r) => ({ start: r.occStart, end: Math.max(r.occEnd, r.occStart + 60_000) }));
  const free = freeWithin(window, busy);
  return free.length === 1 && free[0]?.start === window.start && free[0]?.end === window.end;
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

export const awaitingMe = computed(() =>
  byKind('event')
    .filter(
      (e) =>
        e.rec.kind === 'event' &&
        e.rec.data.status === 'proposed' &&
        e.rec.data.proposed_by === partner.value,
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
