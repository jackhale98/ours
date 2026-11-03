// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Imported calendars (ADR 0011). A `calendar` record (personal key only,
 * because it holds the subscription URL) plus snapshots of its upcoming
 * events: a full copy under the importer's personal key, and a shared copy
 * that is either full or busy-only, depending on what the partner may see.
 */
import { type IcsCalendar, icsOccurrences, parseIcs } from '@ours/core/ics';
import { type CalSnapshotData, MAX_SNAPSHOT_ITEMS } from '@ours/core/schema';
import { addDays, toInstant, toWall } from '@ours/core/time';
import {
  byKind,
  type Entry,
  findEntry,
  put,
  remove,
  type Slot,
  store,
  update,
  viewer,
} from './model';
import { type SnapshotEntry, today, zone } from './select';

export { visibleSnapshots } from './select';

export const SNAPSHOT_DAYS = 60;

export type CalendarEntry = Entry & { rec: { kind: 'calendar' } };

export interface ImportOptions {
  name: string;
  owner: Slot | 'both';
  share: 'full' | 'busy';
  url: string | null;
}

export interface ImportResult {
  calendarId: string;
  events: number;
  truncated: boolean;
  warnings: string[];
}

type Item = CalSnapshotData['items'][number];

/** Expands a parsed calendar into snapshot items for the next SNAPSHOT_DAYS days. */
export function snapshotItems(cal: IcsCalendar): { items: Item[]; truncated: boolean } {
  const first = today.value;
  const from = toInstant(`${first}T00:00`, zone);
  const to = toInstant(`${addDays(first, SNAPSHOT_DAYS)}T00:00`, zone);
  const occ = icsOccurrences(cal, from, to, zone, { max: MAX_SNAPSHOT_ITEMS + 1 });
  const items: Item[] = occ.slice(0, MAX_SNAPSHOT_ITEMS).map((o) => {
    const base: Item = o.all_day
      ? {
          start: o.localStart.slice(0, 10),
          end:
            toWall(o.end, zone).slice(0, 10) > o.localStart.slice(0, 10)
              ? toWall(o.end, zone).slice(0, 10)
              : addDays(o.localStart.slice(0, 10), 1),
          all_day: true,
          tz: null,
        }
      : {
          start: toWall(o.start, zone),
          end: toWall(Math.max(o.end, o.start), zone),
          all_day: false,
          tz: zone,
        };
    return {
      ...base,
      title: (o.title || 'Busy').slice(0, 200),
      location: o.location ? o.location.slice(0, 200) : null,
      ...(o.busy ? {} : { free: true as const }),
    };
  });
  return { items, truncated: occ.length > MAX_SNAPSHOT_ITEMS };
}

const busyOnly = (items: Item[]): Item[] =>
  items.map(({ start, end, all_day, tz, free }) => ({
    start,
    end,
    all_day,
    tz,
    ...(free ? { free } : {}),
  }));

/** Snapshots belonging to a calendar (all scopes). */
function snapshotsOf(calendarId: string): Entry[] {
  return store.value.entries.filter(
    (e) => e.rec.kind === 'cal_snapshot' && e.rec.data.calendar_id === calendarId,
  );
}

/** Writes the private full copy and the shared copy for a calendar. */
function writeSnapshots(
  calendarId: string,
  opts: ImportOptions,
  items: Item[],
  fetchedAt: number,
): void {
  remove(snapshotsOf(calendarId).map((e) => e.id));
  const t = today.value;
  const common = {
    calendar_id: calendarId,
    importer: viewer.value,
    owner: opts.owner,
    window_start: t,
    window_end: addDays(t, SNAPSHOT_DAYS),
    fetched_at: fetchedAt,
  };
  put('cal_snapshot', { ...common, name: opts.name, detail: 'full', items }, { scope: 'user' });
  put(
    'cal_snapshot',
    opts.share === 'full'
      ? { ...common, name: opts.name, detail: 'full', items }
      : { ...common, detail: 'busy', items: busyOnly(items) },
    { scope: 'space' },
  );
}

/** Re-creates a calendar's shared copy from its private full copy (after an import). */
export function rederiveCalendar(id: string): void {
  const cal = findEntry(id) as CalendarEntry | undefined;
  if (cal?.rec.kind !== 'calendar') return;
  const full = snapshotsOf(id).find((e) => e.scope === 'user' && e.rec.kind === 'cal_snapshot');
  if (full?.rec.kind !== 'cal_snapshot') return;
  const d = cal.rec.data;
  writeSnapshots(
    id,
    { name: d.name, owner: d.owner, share: d.share, url: d.url },
    full.rec.data.items,
    full.rec.data.fetched_at,
  );
}

/** Imports .ics text (from a file, or fetched from a subscription link). */
export function importCalendar(text: string, opts: ImportOptions): ImportResult {
  const cal = parseIcs(text, { defaultTz: zone });
  const { items, truncated } = snapshotItems(cal);
  const now = Date.now();
  const calendarId = put(
    'calendar',
    { name: opts.name, url: opts.url, owner: opts.owner, share: opts.share, fetched_at: now },
    { scope: 'user' },
  );
  writeSnapshots(calendarId, opts, items, now);
  return { calendarId, events: items.length, truncated, warnings: cal.warnings };
}

/** Replaces a subscribed calendar's events with a fresh copy of its .ics text. */
export function refreshCalendar(id: string, text: string): ImportResult | null {
  const cal = findEntry(id) as CalendarEntry | undefined;
  if (cal?.rec.kind !== 'calendar') return null;
  const parsed = parseIcs(text, { defaultTz: zone });
  const { items, truncated } = snapshotItems(parsed);
  const now = Date.now();
  const d = cal.rec.data;
  update<'calendar'>(id, { fetched_at: now });
  writeSnapshots(id, { name: d.name, owner: d.owner, share: d.share, url: d.url }, items, now);
  return { calendarId: id, events: items.length, truncated, warnings: parsed.warnings };
}

/** Changes whose calendar it is or what the partner sees, re-deriving the shared copy. */
export function updateCalendar(
  id: string,
  patch: Partial<Pick<ImportOptions, 'owner' | 'share' | 'name'>>,
): void {
  const cal = findEntry(id) as CalendarEntry | undefined;
  if (!cal) return;
  const next = { ...cal.rec.data, ...patch };
  update<'calendar'>(id, patch);
  const full = snapshotsOf(id).find((e) => e.scope === 'user' && e.rec.kind === 'cal_snapshot');
  if (full && full.rec.kind === 'cal_snapshot') {
    writeSnapshots(
      id,
      { name: next.name, owner: next.owner, share: next.share, url: next.url },
      full.rec.data.items,
      full.rec.data.fetched_at,
    );
  }
}

export function removeCalendar(id: string): () => void {
  return remove([id, ...snapshotsOf(id).map((e) => e.id)]);
}

/** Calendars this person imported (they hold the URLs). */
export function myCalendars(): CalendarEntry[] {
  return byKind('calendar') as CalendarEntry[];
}

export type { SnapshotEntry };
