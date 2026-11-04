// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { commonFree, dailyWindows, freeWithin, mergeIntervals } from './free';
import { daysTouched, expand, isValidRRule, nextDueDate, type Schedulable } from './recurrence';
import {
  addDays,
  addWallMinutes,
  dateIn,
  offsetMinutes,
  parseWall,
  startOfWeek,
  toInstant,
  toWall,
  wallMinutes,
  weekday,
  zoneDiffers,
} from './zones';

const H = 60 * 60_000;
const utc = (s: string) => Date.parse(`${s}Z`);

describe('zones', () => {
  it('converts wall time to instants and back', () => {
    expect(toInstant('2026-07-01T09:00', 'Europe/London')).toBe(utc('2026-07-01T08:00'));
    expect(toInstant('2026-12-01T09:00', 'Europe/London')).toBe(utc('2026-12-01T09:00'));
    expect(toWall(utc('2026-07-01T08:00'), 'America/New_York')).toBe('2026-07-01T04:00');
    expect(dateIn(utc('2026-07-01T23:30'), 'Asia/Tokyo')).toBe('2026-07-02');
  });

  it('resolves spring-forward gaps forward', () => {
    // 2026-03-08 02:30 does not exist in New York.
    const t = toInstant('2026-03-08T02:30', 'America/New_York');
    expect(toWall(t, 'America/New_York')).toBe('2026-03-08T03:30');
  });

  it('reports offsets and zone differences', () => {
    const summer = utc('2026-07-01T12:00');
    expect(offsetMinutes('Europe/Berlin', summer)).toBe(120);
    expect(offsetMinutes('UTC', summer)).toBe(0);
    expect(zoneDiffers('Europe/London', 'Europe/Lisbon', summer)).toBe(false);
    expect(zoneDiffers('Europe/London', 'America/Chicago', summer)).toBe(true);
  });

  it('does calendar arithmetic without zones', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(weekday('2026-11-03')).toBe(2);
    expect(startOfWeek('2026-11-03', 1)).toBe('2026-11-02');
    expect(startOfWeek('2026-11-01', 1)).toBe('2026-10-26');
    expect(startOfWeek('2026-11-01', 0)).toBe('2026-11-01');
    expect(wallMinutes('2026-11-01T23:00', '2026-11-02T01:30')).toBe(150);
    expect(addWallMinutes('2026-11-01T23:00', 90)).toBe('2026-11-02T00:30');
    expect(() => parseWall('11/03/2026')).toThrow(RangeError);
  });
});

describe('expand', () => {
  const weekly: Schedulable = {
    start: '2026-03-07T09:00',
    end: '2026-03-07T10:00',
    all_day: false,
    tz: 'Europe/London',
    rrule: 'FREQ=WEEKLY;BYDAY=SA',
  };

  it('returns a single event that overlaps the range', () => {
    const e = { ...weekly, rrule: null };
    expect(expand(e, utc('2026-03-07T00:00'), utc('2026-03-08T00:00'), 'UTC')).toEqual([
      {
        start: utc('2026-03-07T09:00'),
        end: utc('2026-03-07T10:00'),
        localStart: '2026-03-07T09:00',
        index: 0,
      },
    ]);
    expect(expand(e, utc('2026-03-07T10:00'), utc('2026-03-08T00:00'), 'UTC')).toEqual([]);
    expect(expand(e, utc('2026-03-07T09:30'), utc('2026-03-08T00:00'), 'UTC')).toHaveLength(1);
  });

  it('keeps local wall time across a DST change', () => {
    const out = expand(weekly, utc('2026-03-20T00:00'), utc('2026-04-05T00:00'), 'UTC');
    // UK clocks go forward on 2026-03-29.
    expect(out.map((o) => o.localStart)).toEqual([
      '2026-03-21T09:00',
      '2026-03-28T09:00',
      '2026-04-04T09:00',
    ]);
    expect(out.map((o) => new Date(o.start).toISOString().slice(11, 16))).toEqual([
      '09:00',
      '09:00',
      '08:00',
    ]);
    // Indexes are stable per occurrence (wall-clock start, in minutes).
    expect(new Set(out.map((o) => o.index)).size).toBe(3);
    expect(out[0]?.index).toBe(Date.UTC(2026, 2, 21, 9, 0) / 60_000);
    expect(out.every((o) => o.end - o.start === H)).toBe(true);
  });

  it('honours COUNT and UNTIL', () => {
    const counted = { ...weekly, rrule: 'FREQ=DAILY;COUNT=3' };
    expect(expand(counted, utc('2026-01-01T00:00'), utc('2027-01-01T00:00'), 'UTC')).toHaveLength(
      3,
    );
    const until = { ...weekly, rrule: 'FREQ=DAILY;UNTIL=20260310T235959Z' };
    expect(expand(until, utc('2026-01-01T00:00'), utc('2027-01-01T00:00'), 'UTC')).toHaveLength(4);
  });

  it('includes an occurrence that started before the range and is still running', () => {
    const late = { ...weekly, start: '2026-03-07T23:00', end: '2026-03-08T02:00', tz: 'UTC' };
    const out = expand(late, utc('2026-03-15T01:00'), utc('2026-03-15T03:00'), 'UTC');
    expect(out.map((o) => o.localStart)).toEqual(['2026-03-14T23:00']);
  });

  it('places all-day events on the same date for every viewer', () => {
    const allDay: Schedulable = {
      start: '2026-12-24',
      end: '2026-12-26',
      all_day: true,
      tz: null,
      rrule: null,
    };
    const tokyo = expand(allDay, utc('2026-12-20T00:00'), utc('2026-12-30T00:00'), 'Asia/Tokyo');
    const la = expand(
      allDay,
      utc('2026-12-20T00:00'),
      utc('2026-12-30T00:00'),
      'America/Los_Angeles',
    );
    expect(tokyo[0]?.localStart).toBe('2026-12-24');
    expect(
      daysTouched(tokyo[0] ?? { start: 0, end: 0, localStart: '', index: 0 }, 'Asia/Tokyo'),
    ).toEqual(['2026-12-24', '2026-12-25']);
    expect(
      daysTouched(la[0] ?? { start: 0, end: 0, localStart: '', index: 0 }, 'America/Los_Angeles'),
    ).toEqual(['2026-12-24', '2026-12-25']);
  });

  it('expands yearly all-day events (birthdays)', () => {
    const bday: Schedulable = {
      start: '2020-05-17',
      end: '2020-05-18',
      all_day: true,
      tz: null,
      rrule: 'FREQ=YEARLY',
    };
    const out = expand(bday, utc('2026-01-01T00:00'), utc('2027-01-01T00:00'), 'Europe/Paris');
    expect(out.map((o) => o.localStart)).toEqual(['2026-05-17']);
    expect(out[0]?.index).toBe(Date.UTC(2026, 4, 17) / 60_000);
  });

  it('counts zero-length events that start in range', () => {
    const z = { ...weekly, end: weekly.start, rrule: null };
    expect(expand(z, utc('2026-03-07T09:00'), utc('2026-03-07T09:01'), 'UTC')).toHaveLength(1);
    const zr = { ...weekly, end: weekly.start };
    expect(expand(zr, utc('2026-03-14T09:00'), utc('2026-03-14T09:01'), 'UTC')).toHaveLength(1);
  });

  it('caps runaway rules and ignores invalid ones', () => {
    const minutely = { ...weekly, rrule: 'FREQ=DAILY' };
    expect(
      expand(minutely, utc('2026-01-01T00:00'), utc('2040-01-01T00:00'), 'UTC').length,
    ).toBeLessThanOrEqual(1000);
    expect(expand({ ...weekly, rrule: 'nonsense' }, 0, Number.MAX_SAFE_INTEGER, 'UTC')).toEqual([]);
    expect(() => expand({ ...weekly, tz: null }, 0, 1, 'UTC')).toThrow(RangeError);
  });

  it.each([
    ['FREQ=WEEKLY;BYDAY=MO,WE', true],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', true],
    ['FREQ=YEARLY;INTERVAL=2', true],
    ['FREQ=MINUTELY', false],
    ['FREQ=HOURLY', false],
    ['BYDAY=MO', false],
    ['DTSTART=20260101T000000Z;FREQ=DAILY', false],
    ['FREQ=DAILY;TZID=Europe/London', false],
    ['FREQ=WEEKLY;BYDAY', false],
    ['x'.repeat(600), false],
  ])('validates rule %s', (rule, ok) => {
    expect(isValidRRule(rule)).toBe(ok);
  });
});

describe('free time', () => {
  const i = (a: number, b: number) => ({ start: a * H, end: b * H });

  it('merges intervals', () => {
    expect(mergeIntervals([i(5, 6), i(1, 3), i(2, 4), i(4, 4.5), i(7, 7)])).toEqual([
      i(1, 4.5),
      i(5, 6),
    ]);
  });

  it('subtracts busy time from a window', () => {
    expect(freeWithin(i(17, 22), [i(18, 19), i(20, 23)])).toEqual([i(17, 18), i(19, 20)]);
    expect(freeWithin(i(17, 22), [])).toEqual([i(17, 22)]);
    expect(freeWithin(i(17, 22), [i(10, 23)])).toEqual([]);
    expect(freeWithin(i(17, 22), [i(1, 2), i(23, 24)])).toEqual([i(17, 22)]);
  });

  it('finds slots where both are free for long enough', () => {
    const windows = [i(17, 22), i(41, 46)];
    const sam = [i(17, 18.5)];
    const alex = [i(20, 21), i(41, 46)];
    expect(commonFree(windows, [sam, alex], 60)).toEqual([i(18.5, 20), i(21, 22)]);
    expect(commonFree(windows, [sam, alex], 90)).toEqual([i(18.5, 20)]);
    expect(commonFree(windows, [sam, alex], 120)).toEqual([]);
  });

  it('builds daily windows in a zone, including ones that cross midnight', () => {
    const w = dailyWindows('2026-11-03', 2, 'America/New_York', '17:00', '22:00');
    expect(w).toEqual([
      { start: utc('2026-11-03T22:00'), end: utc('2026-11-04T03:00') },
      { start: utc('2026-11-04T22:00'), end: utc('2026-11-05T03:00') },
    ]);
    const late = dailyWindows('2026-11-03', 1, 'UTC', '22:00', '01:00');
    expect(late).toEqual([{ start: utc('2026-11-03T22:00'), end: utc('2026-11-04T01:00') }]);
  });
});

describe('hostile recurrence rules (review 0004)', () => {
  it('rejects rules that can never produce a date, instead of scanning to year 9999', () => {
    for (const bad of [
      'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
      'FREQ=YEARLY;BYMONTH=4,6,9,11;BYMONTHDAY=31',
      'FREQ=MONTHLY;BYDAY=5FR;BYMONTHDAY=1',
      'FREQ=WEEKLY;BYDAY=MO;BYSETPOS=5',
      'FREQ=DAILY;INTERVAL=0',
    ]) {
      expect(isValidRRule(bad), bad).toBe(false);
    }
    for (const ok of [
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
      'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13',
      'FREQ=MONTHLY;BYDAY=-1FR',
      'FREQ=MONTHLY;BYMONTHDAY=31',
    ]) {
      expect(isValidRRule(ok), ok).toBe(true);
    }
  });

  it('shows a long-running daily series today, however old (review 0004, L5)', () => {
    const daily = {
      start: '2015-01-01T07:00',
      end: '2015-01-01T07:30',
      all_day: false,
      tz: 'UTC',
      rrule: 'FREQ=DAILY',
    };
    const out = expand(daily, utc('2026-11-02T00:00'), utc('2026-11-09T00:00'), 'UTC');
    expect(out).toHaveLength(7);
  });

  it('still honours COUNT from the first date', () => {
    const ten = {
      start: '2026-01-01T07:00',
      end: '2026-01-01T07:30',
      all_day: false,
      tz: 'UTC',
      rrule: 'FREQ=DAILY;COUNT=10',
    };
    expect(expand(ten, utc('2026-01-05T00:00'), utc('2026-02-01T00:00'), 'UTC')).toHaveLength(6);
  });
});

describe('next due date for repeating tasks', () => {
  const TUE = '2026-11-03';
  it('moves on from the due date when done on time or early', () => {
    expect(nextDueDate('FREQ=WEEKLY', TUE, TUE)).toBe('2026-11-10');
    expect(nextDueDate('FREQ=DAILY', '2026-11-05', TUE)).toBe('2026-11-06');
    expect(nextDueDate('FREQ=MONTHLY', '2026-11-30', TUE)).toBe('2026-12-30');
    expect(nextDueDate('FREQ=WEEKLY;INTERVAL=2', TUE, TUE)).toBe('2026-11-17');
  });
  it('moves on from today when overdue, keeping the rhythm', () => {
    // Due Monday 26 Oct, done Tuesday 3 Nov: next Monday is 9 Nov.
    expect(nextDueDate('FREQ=WEEKLY', '2026-10-26', TUE)).toBe('2026-11-09');
    expect(nextDueDate('FREQ=WEEKLY;BYDAY=MO,TH', '2026-10-26', TUE)).toBe('2026-11-05');
  });
  it('starts from today when there is no due date', () => {
    expect(nextDueDate('FREQ=WEEKLY;BYDAY=SA', null, TUE)).toBe('2026-11-07');
    expect(nextDueDate('FREQ=DAILY', null, TUE)).toBe('2026-11-04');
  });
  it('refuses rules it cannot use', () => {
    expect(nextDueDate('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30', TUE, TUE)).toBeNull();
    expect(nextDueDate('nonsense', TUE, TUE)).toBeNull();
  });
});

describe('one day of a series, changed on its own', () => {
  const weekly: Schedulable = {
    start: '2026-11-02T19:00', // a Monday
    end: '2026-11-02T20:00',
    all_day: false,
    tz: 'Europe/London',
    rrule: 'FREQ=WEEKLY',
  };
  const from = Date.parse('2026-11-01T00:00:00Z');
  const to = Date.parse('2026-11-30T00:00:00Z');
  const starts = (e: Schedulable) => expand(e, from, to, 'Europe/London').map((o) => o.localStart);

  it('a skipped day drops out and the rest stay', () => {
    expect(starts({ ...weekly, except: [{ at: '2026-11-09T19:00', to: null }] })).toEqual([
      '2026-11-02T19:00',
      '2026-11-16T19:00',
      '2026-11-23T19:00',
    ]);
  });

  it('a moved day shows at its new time and keeps its identity', () => {
    const plain = expand(weekly, from, to, 'Europe/London');
    const moved = expand(
      {
        ...weekly,
        except: [
          { at: '2026-11-09T19:00', to: { start: '2026-11-11T18:30', end: '2026-11-11T19:30' } },
        ],
      },
      from,
      to,
      'Europe/London',
    );
    expect(moved.map((o) => o.localStart)).toEqual([
      '2026-11-02T19:00',
      '2026-11-11T18:30',
      '2026-11-16T19:00',
      '2026-11-23T19:00',
    ]);
    const m = moved[1];
    expect(m?.movedFrom).toBe('2026-11-09T19:00');
    expect(m?.index).toBe(plain[1]?.index);
    expect(m?.end).toBe(Date.parse('2026-11-11T19:30:00Z'));
  });

  it('a day moved out of the window leaves it, one moved in joins it', () => {
    const out = starts({
      ...weekly,
      except: [
        { at: '2026-11-23T19:00', to: { start: '2026-12-01T19:00', end: '2026-12-01T20:00' } },
      ],
    });
    expect(out).not.toContain('2026-11-23T19:00');
    expect(out).toHaveLength(3);
    const into = starts({
      ...weekly,
      except: [
        { at: '2026-12-07T19:00', to: { start: '2026-11-28T10:00', end: '2026-11-28T11:00' } },
      ],
    });
    expect(into).toContain('2026-11-28T10:00');
  });

  it('works for all-day plans', () => {
    const allDay: Schedulable = {
      start: '2026-11-07',
      end: '2026-11-08',
      all_day: true,
      tz: null,
      rrule: 'FREQ=WEEKLY',
      except: [
        { at: '2026-11-14', to: null },
        { at: '2026-11-21', to: { start: '2026-11-22', end: '2026-11-23' } },
      ],
    };
    expect(starts(allDay)).toEqual(['2026-11-07', '2026-11-22', '2026-11-28']);
  });
});
