// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { createEvent, type EventData, findEntry, loadEntries, setBackend } from './model';
import { readRule, writeRule } from './planform';
import { now, repeatText, zone } from './select';
import { routinesDuring, skipBetween, skipRoutines, splitSeries } from './series';

const gym = (p: Partial<EventData> = {}): EventData => ({
  title: 'Gym',
  start: '2026-11-02T07:00',
  end: '2026-11-02T08:00',
  all_day: false,
  tz: zone,
  rrule: 'FREQ=DAILY',
  away: false,
  owner: 'a',
  status: 'confirmed',
  proposed_by: null,
  privacy: 'full',
  location: null,
  notes: null,
  countdown: false,
  stub_id: null,
  ...p,
});
const data = (id: string) => {
  const e = findEntry(id);
  if (e?.rec.kind !== 'event') throw new Error('gone');
  return e.rec.data;
};

beforeEach(() => {
  setBackend({ mode: 'demo', deviceId: (s) => `test-${s}`, write: () => {} });
  loadEntries('a', []);
  now.value = Date.parse('2026-11-03T12:00:00Z');
});

describe('series (review 0009, P-6)', () => {
  it('skips a run of days in one go, with undo', () => {
    const id = createEvent(gym());
    const r = skipBetween(id, '2026-11-10', '2026-11-16');
    expect(r.n).toBe(7);
    expect(data(id).except?.map((x) => x.at)).toContain('2026-11-16T07:00');
    // Again: nothing new to skip.
    expect(skipBetween(id, '2026-11-10', '2026-11-12').n).toBe(0);
    r.undo();
    expect(data(id).except ?? []).toEqual([]);
  });

  it('finds and skips routines while away: yours and ours, not theirs', () => {
    const mine = createEvent(gym());
    const ours = createEvent(gym({ title: 'Walk the dog', owner: 'both' }));
    const theirs = createEvent(gym({ title: 'Swim', owner: 'b' }));
    const ids = routinesDuring('a', '2026-11-20', '2026-11-22');
    expect(ids.sort()).toEqual([mine, ours].sort());
    expect(ids).not.toContain(theirs);
    const r = skipRoutines(ids, '2026-11-20', '2026-11-22');
    expect(r.n).toBe(6);
    r.undo();
    expect(data(mine).except ?? []).toEqual([]);
  });

  it('splits a series: the old part ends the day before, the copy carries later skips', () => {
    const id = createEvent(
      gym({
        rrule: 'FREQ=WEEKLY;COUNT=10',
        except: [
          { at: '2026-11-09T07:00', to: null },
          { at: '2026-11-23T07:00', to: null },
        ],
      }),
    );
    const copy = splitSeries(id, '2026-11-16T07:00') as string;
    expect(copy).toBeTruthy();
    expect(data(id).rrule).toBe('FREQ=WEEKLY;UNTIL=20261115T235959Z');
    expect(data(id).except?.map((x) => x.at)).toEqual(['2026-11-09T07:00']);
    expect(data(copy)).toMatchObject({
      start: '2026-11-16T07:00',
      end: '2026-11-16T08:00',
      rrule: 'FREQ=WEEKLY;COUNT=8',
    });
    expect(data(copy).except?.map((x) => x.at)).toEqual(['2026-11-23T07:00']);
    expect(splitSeries(id, '2026-11-02T07:00')).toBeNull();
  });
});

describe('repeat rules in the form (review 0009, P-6)', () => {
  it('reads and writes weekdays and ends, leaving rules it does not edit alone', () => {
    const r = readRule('FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10');
    expect(r).toEqual({ base: 'FREQ=WEEKLY', byday: ['TU', 'TH'], until: null, count: 10 });
    expect(writeRule({ ...(r as NonNullable<typeof r>), until: '2027-01-31' })).toBe(
      'FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20270131T235959Z',
    );
    expect(
      writeRule({ base: 'FREQ=WEEKLY;INTERVAL=2', byday: ['MO'], until: null, count: null }),
    ).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
    expect(readRule('FREQ=MONTHLY;BYMONTHDAY=1')).toBeNull();
    expect(readRule('FREQ=MONTHLY;BYDAY=2TU')).toBeNull();
    expect(repeatText('FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10')).toMatch(/Tue/);
    expect(repeatText('FREQ=DAILY;UNTIL=20270131T235959Z')).toBeTruthy();
  });
});
