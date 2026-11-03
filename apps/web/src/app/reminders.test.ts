// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  allDayMinutes,
  allDayParts,
  duration,
  MAX_REMINDERS,
  reminderLabel,
  reminderProblem,
} from './reminders';

describe('reminder labels', () => {
  it('describes any timed offset in words', () => {
    expect(reminderLabel(0)).toBe('At the start');
    expect(reminderLabel(10)).toBe('10 minutes before');
    expect(reminderLabel(60)).toBe('1 hour before');
    expect(reminderLabel(90)).toBe('1 hour 30 minutes before');
    expect(reminderLabel(1440)).toBe('1 day before');
    expect(reminderLabel(2 * 1440 + 180)).toBe('2 days 3 hours before');
    expect(reminderLabel(2 * 10080)).toBe('2 weeks before');
    expect(duration(1)).toBe('1 minute');
  });

  it('describes all-day reminders as a day and a time', () => {
    expect(reminderLabel(0, true)).toMatch(/^On the day at 9/);
    expect(reminderLabel(900, true)).toMatch(/^The day before at 6/);
    expect(reminderLabel(1440, true)).toMatch(/^The day before at 9/);
    expect(reminderLabel(10080, true)).toMatch(/^1 week before at 9/);
    expect(reminderLabel(3 * 1440, true)).toMatch(/^3 days before at 9/);
    // Later on the day itself (after 9 AM) is a negative offset.
    expect(reminderLabel(-180, true)).toMatch(/^On the day at 12/);
  });

  it('round-trips days-before-at-time', () => {
    for (const [d, t] of [
      [0, '07:00'],
      [0, '23:59'],
      [1, '18:00'],
      [2, '00:00'],
      [28, '09:00'],
    ] as const) {
      expect(allDayParts(allDayMinutes(d, t))).toEqual({ daysBefore: d, time: t });
    }
  });
});

describe('custom reminder checks', () => {
  it('refuses duplicates, too many, out of range and fractions', () => {
    expect(reminderProblem(30, false, [30])).toMatch(/already/);
    expect(
      reminderProblem(
        5,
        false,
        Array.from({ length: MAX_REMINDERS }, (_, i) => i + 100),
      ),
    ).toMatch(/Up to/);
    expect(reminderProblem(-5, false, [])).toMatch(/before the start/);
    expect(reminderProblem(29 * 1440, false, [])).toMatch(/4 weeks/);
    expect(reminderProblem(1.5, false, [])).toMatch(/whole/);
    expect(reminderProblem(allDayMinutes(29, '09:00'), true, [])).toMatch(/28 days/);
    expect(reminderProblem(allDayMinutes(0, '23:59'), true, [])).toBeNull();
    expect(reminderProblem(45, false, [])).toBeNull();
  });
});
