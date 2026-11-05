// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Working with a repeating plan as a whole (review 0009, P-6): skipping a
 * run of days at once, skipping routines while away, and changing a series
 * from one day on ("this and following") by ending it there and starting a
 * copy.
 */
import { MAX_EXCEPTIONS } from '@ours/core/schema';
import { addDays, addWallMinutes, expand, toInstant, wallMinutes } from '@ours/core/time';
import {
  bulk,
  byKind,
  createEvent,
  type EventData,
  findEntry,
  type Slot,
  updateEvent,
} from './model';
import { zone } from './select';

type Except = NonNullable<EventData['except']>[number];

/** The days of a series between two dates (inclusive), each by the name it skips under. */
function daysOf(e: EventData, from: string, to: string): string[] {
  const occs = expand(
    { ...e, except: (e.except ?? []).filter((x) => x.to) },
    toInstant(`${from}T00:00`, zone),
    toInstant(`${addDays(to, 1)}T00:00`, zone),
    zone,
  );
  return occs.map((o) => o.movedFrom ?? o.localStart);
}

/** Skips every day of a repeating plan from `from` to `to`. Returns undo and how many. */
export function skipBetween(id: string, from: string, to: string): { undo: () => void; n: number } {
  const entry = findEntry(id);
  if (entry?.rec.kind !== 'event' || !entry.rec.data.rrule || to < from)
    return { undo: () => {}, n: 0 };
  const e = entry.rec.data;
  const before = e.except ?? [];
  const days = daysOf(e, from, to);
  const skipped = new Set(before.filter((x) => !x.to).map((x) => x.at));
  const fresh = days.filter((d) => !skipped.has(d));
  if (!fresh.length) return { undo: () => {}, n: 0 };
  const next: Except[] = [
    ...before.filter((x) => !fresh.includes(x.at)),
    ...fresh.map((at) => ({ at, to: null })),
  ].slice(-MAX_EXCEPTIONS);
  updateEvent(id, { except: next });
  return { undo: () => updateEvent(id, { except: before }), n: fresh.length };
}

/**
 * Routines of a person (or both of you) that fall on the days of a trip:
 * offered as "Skip these while you're away".
 */
export function routinesDuring(owner: Slot | 'both', from: string, to: string): string[] {
  const out: string[] = [];
  for (const e of byKind('event')) {
    if (e.rec.kind !== 'event' || !e.rec.data.rrule || e.rec.data.all_day) continue;
    const o = e.rec.data.owner;
    // Both away: every routine. One away: theirs, and the ones you do together.
    if (!(owner === 'both' || o === owner || o === 'both')) continue;
    if (e.rec.data.status === 'declined') continue;
    if (daysOf(e.rec.data, from, to).length) out.push(e.id);
  }
  return out;
}

/** Skips those routines' days in one go. Returns undo and how many days. */
export function skipRoutines(
  ids: string[],
  from: string,
  to: string,
): { undo: () => void; n: number } {
  const undos: (() => void)[] = [];
  let n = 0;
  bulk(() => {
    for (const id of ids) {
      const r = skipBetween(id, from, to);
      undos.push(r.undo);
      n += r.n;
    }
  });
  return {
    n,
    undo: () =>
      bulk(() => {
        for (const u of undos.reverse()) u();
      }),
  };
}

const parts = (rule: string) =>
  new Map(rule.split(';').map((p) => p.split('=') as [string, string]));
const join = (m: Map<string, string>) => [...m].map(([k, v]) => `${k}=${v}`).join(';');

/**
 * "This and following": the series ends the day before `occ` and a copy
 * starts on it, with the days skipped or moved from then on. Returns the
 * copy's id, to edit; null if `occ` is its first day (edit it all instead).
 */
export function splitSeries(id: string, occ: string): string | null {
  const entry = findEntry(id);
  if (entry?.rec.kind !== 'event' || !entry.rec.data.rrule) return null;
  const e = entry.rec.data;
  const day = occ.slice(0, 10);
  if (day <= e.start.slice(0, 10)) return null;
  const rule = parts(e.rrule as string);
  // A COUNT goes on with what's left; the old part ends by date instead.
  const count = rule.has('COUNT') ? Number(rule.get('COUNT')) : null;
  const done = count
    ? daysOf({ ...e, except: [] }, e.start.slice(0, 10), addDays(day, -1)).length
    : 0;
  const old = new Map(rule);
  old.delete('COUNT');
  old.set('UNTIL', `${addDays(day, -1).replace(/-/g, '')}T235959Z`);
  const next = new Map(rule);
  if (count) next.set('COUNT', String(Math.max(1, count - done)));
  const length = wallMinutes(e.start, e.end);
  const start = e.all_day ? day : `${day}T${e.start.slice(11)}`;
  const end = e.all_day
    ? addDays(day, Math.max(1, Math.round(length / 1440)))
    : addWallMinutes(start, length);
  const later = (e.except ?? []).filter((x) => x.at.slice(0, 10) >= day);
  let copy: string | null = null;
  bulk(() => {
    updateEvent(id, {
      rrule: join(old),
      except: (e.except ?? []).filter((x) => x.at.slice(0, 10) < day),
    });
    const { stub_id: _stub, ...rest } = e;
    copy = createEvent({ ...rest, start, end, rrule: join(next), except: later, stub_id: null });
  });
  return copy;
}
