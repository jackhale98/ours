// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conversions between wall-clock strings in an IANA zone and instants
 * (epoch milliseconds). Wall-clock strings are 'YYYY-MM-DDTHH:mm';
 * dates are 'YYYY-MM-DD'.
 */
import { TZDate, tzOffset } from '@date-fns/tz';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

export function parseWall(local: string): WallTime {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(local);
  if (!m) throw new RangeError(`Invalid local date/time: ${local}`);
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
  };
}

export function formatWall(w: WallTime): string {
  return `${formatDate(w)}T${pad(w.hour)}:${pad(w.minute)}`;
}

export function formatDate(w: Pick<WallTime, 'year' | 'month' | 'day'>): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * Instant for a wall-clock time in `tz`. Times that do not exist (inside a
 * spring-forward gap) resolve to the instant after the gap.
 */
export function toInstant(local: string, tz: string): number {
  const w = parseWall(local);
  return new TZDate(w.year, w.month - 1, w.day, w.hour, w.minute, tz).getTime();
}

export function toWall(instant: number, tz: string): string {
  const d = new TZDate(instant, tz);
  return formatWall({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
  });
}

/** The calendar date at `instant` in `tz`. */
export function dateIn(instant: number, tz: string): string {
  return toWall(instant, tz).slice(0, 10);
}

/** UTC offset of `tz` at `instant`, in minutes (e.g. +60 for CET in winter). */
export function offsetMinutes(tz: string, instant: number): number {
  return tzOffset(tz, new Date(instant));
}

/** True if an event's zone shows a different clock time than the viewer's at that instant. */
export function zoneDiffers(eventTz: string, viewerTz: string, instant: number): boolean {
  return offsetMinutes(eventTz, instant) !== offsetMinutes(viewerTz, instant);
}

/** Calendar arithmetic on 'YYYY-MM-DD' strings, independent of any zone. */
export function addDays(date: string, days: number): string {
  const w = parseWall(date);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return formatDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  const w = parseWall(date);
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

/** Minutes between two wall-clock strings, ignoring zones (wall-clock duration). */
export function wallMinutes(from: string, to: string): number {
  const a = parseWall(from);
  const b = parseWall(to);
  return (
    (Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute) -
      Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute)) /
    60_000
  );
}

/** Adds wall-clock minutes to a wall-clock string. */
export function addWallMinutes(local: string, minutes: number): string {
  const w = parseWall(local);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute + minutes));
  return formatWall({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  });
}

/** The first day of the week containing `date`. */
export function startOfWeek(date: string, weekStart: number): string {
  return addDays(date, -((weekday(date) - weekStart + 7) % 7));
}
