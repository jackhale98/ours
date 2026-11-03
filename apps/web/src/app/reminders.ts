// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reminder choices, labels and defaults. A reminder is minutes before the
 * start; for all-day plans, minutes before 9 AM on the day (so "the day
 * before" is 9 AM the previous day and "the evening before" 6 PM).
 */
import { MAX_REMINDERS_PER_PERSON } from '@ours/core/schema';
import { type EventData, type Slot, settings, updateSettings } from './model';

export const MAX_REMINDERS = MAX_REMINDERS_PER_PERSON;

export const TIMED_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080] as const;
export const ALL_DAY_CHOICES = [0, 900, 1440, 2880, 10080] as const;

export function reminderLabel(minutes: number, allDay = false): string {
  if (allDay) {
    if (minutes === 0) return 'Morning of (9 AM)';
    if (minutes === 900) return 'Evening before (6 PM)';
    if (minutes === 1440) return 'Day before (9 AM)';
    if (minutes % 10080 === 0)
      return minutes === 10080 ? 'A week before' : `${minutes / 10080} weeks before`;
    if (minutes % 1440 === 0) return `${minutes / 1440} days before`;
  }
  if (minutes === 0) return 'At the start';
  if (minutes < 60) return `${minutes} minutes before`;
  if (minutes < 1440)
    return minutes === 60
      ? '1 hour before'
      : `${Math.round((minutes / 60) * 10) / 10} hours before`;
  if (minutes === 10080) return 'A week before';
  return minutes === 1440 ? '1 day before' : `${Math.round(minutes / 1440)} days before`;
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
