// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reminder choices, labels and defaults. A reminder is minutes before the
 * start; for all-day plans, minutes before 9 AM on the day (so "the day
 * before" is 9 AM the previous day and "the evening before" 6 PM).
 */
import { MAX_REMINDERS_PER_PERSON } from '@ours/core/schema';
import { type EventData, type Slot, settings, updateSettings } from './model';

export const MAX_REMINDERS = MAX_REMINDERS_PER_PERSON;

/** One-tap choices; anything else is built with the custom reminder fields. */
export const TIMED_CHOICES = [0, 10, 30, 60, 1440] as const;
export const ALL_DAY_CHOICES = [0, 900, 1440, 10080] as const;

/** All-day reminders count from this time on the day (minutes after midnight). */
export const ALL_DAY_ANCHOR = 9 * 60;
export const MAX_TIMED_MINUTES = 28 * 1440;
export const MAX_DAYS_BEFORE = 28;

export type Unit = 'minutes' | 'hours' | 'days' | 'weeks';
export const UNIT_MINUTES: Record<Unit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10080,
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "1 hour 30 minutes", "2 days", "3 weeks". */
export function duration(minutes: number): string {
  if (minutes % 10080 === 0) return plural(minutes / 10080, 'week');
  const parts: string[] = [];
  let m = minutes;
  for (const [size, word] of [
    [1440, 'day'],
    [60, 'hour'],
    [1, 'minute'],
  ] as const) {
    const n = Math.floor(m / size);
    if (n) parts.push(plural(n, word));
    m -= n * size;
  }
  return parts.join(' ');
}

const clock = (minutesAfterMidnight: number) => {
  const h = Math.floor(minutesAfterMidnight / 60);
  const m = minutesAfterMidnight % 60;
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: m ? '2-digit' : undefined,
    timeZone: 'UTC',
  });
};

/** For an all-day reminder: how many days before the plan, and the time of day. */
export function allDayParts(minutes: number): { daysBefore: number; time: string } {
  const fire = ALL_DAY_ANCHOR - minutes; // minutes after midnight on the plan's day (≤ 0 is earlier)
  const dayOffset = Math.floor(fire / 1440);
  const t = fire - dayOffset * 1440;
  return {
    daysBefore: dayOffset === 0 ? 0 : -dayOffset,
    time: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`,
  };
}

/** Minutes for "N days before at HH:MM" on an all-day plan. */
export function allDayMinutes(daysBefore: number, time: string): number {
  const [h, m] = time.split(':').map(Number);
  return daysBefore * 1440 + ALL_DAY_ANCHOR - ((h ?? 0) * 60 + (m ?? 0));
}

export function reminderLabel(minutes: number, allDay = false): string {
  if (allDay) {
    const { daysBefore, time } = allDayParts(minutes);
    const [h, m] = time.split(':').map(Number);
    const at = clock((h ?? 0) * 60 + (m ?? 0));
    const when =
      daysBefore === 0
        ? 'On the day'
        : daysBefore === 1
          ? 'The day before'
          : daysBefore % 7 === 0
            ? `${plural(daysBefore / 7, 'week')} before`
            : `${daysBefore} days before`;
    return `${when} at ${at}`;
  }
  return minutes === 0 ? 'At the start' : `${duration(minutes)} before`;
}

/** Why a custom reminder can't be added, or null if it can. */
export function reminderProblem(
  minutes: number,
  allDay: boolean,
  existing: number[],
): string | null {
  if (!Number.isInteger(minutes)) return 'Enter a whole number.';
  if (existing.includes(minutes)) return 'You already have that reminder.';
  if (existing.length >= MAX_REMINDERS) return `Up to ${MAX_REMINDERS} reminders per plan.`;
  if (allDay) {
    if (minutes < -(1439 - ALL_DAY_ANCHOR)) return 'Choose a time on or before the day.';
    if (minutes > MAX_DAYS_BEFORE * 1440 + ALL_DAY_ANCHOR)
      return `Up to ${MAX_DAYS_BEFORE} days before.`;
  } else {
    if (minutes < 0) return 'Reminders come before the start.';
    if (minutes > MAX_TIMED_MINUTES) return 'Up to 4 weeks before.';
  }
  return null;
}

/** This person's reminders on a plan, soonest first (older records hold one number). */
export function remindersOf(d: Pick<EventData, 'remind'>, slot: Slot): number[] {
  const r = d.remind?.[slot];
  if (r === null || r === undefined) return [];
  return [...new Set(Array.isArray(r) ? r : [r])].sort((x, y) => x - y);
}

/** The remind field with this person's reminders replaced. */
export function withReminders(
  d: Pick<EventData, 'remind'>,
  slot: Slot,
  list: number[],
): NonNullable<EventData['remind']> {
  const prev = d.remind ?? { a: null, b: null };
  const next = [...new Set(list)].sort((x, y) => x - y).slice(0, MAX_REMINDERS);
  return { ...prev, [slot]: next.length ? next : null };
}

export interface DefaultReminders {
  timed: number[];
  all_day: number[];
}

export function defaultReminders(slot: Slot): DefaultReminders {
  const d = settings.value.default_reminders?.[slot];
  return { timed: d?.timed ?? [], all_day: d?.all_day ?? [] };
}

export function setDefaultReminders(slot: Slot, value: DefaultReminders): void {
  updateSettings({
    default_reminders: { ...settings.value.default_reminders, [slot]: value },
  });
}

/** A new or accepted plan gets this person's default reminders, if they set any. */
export function withDefaultReminders(d: EventData, slot: Slot): EventData {
  if (remindersOf(d, slot).length) return d;
  const defs = defaultReminders(slot);
  const list = d.all_day ? defs.all_day : defs.timed;
  return list.length ? { ...d, remind: withReminders(d, slot, list) } : d;
}
