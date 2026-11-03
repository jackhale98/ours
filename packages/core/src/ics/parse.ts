// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tolerant iCalendar (RFC 5545) reader for imported calendar feeds.
 *
 * Feeds are untrusted: `parseIcs` never throws, caps its work, and turns
 * anything it cannot use into a warning. Times are kept as wall-clock strings
 * in an IANA zone (VTIMEZONE definitions are ignored; TZID names are resolved
 * through IANA, the Windows zone map, or the calendar default zone).
 */
import { isTimeZone } from '../schema/records';
import { isValidRRule } from '../time/recurrence';
import { addDays, addWallMinutes, toInstant, toWall } from '../time/zones';
import { windowsToIana } from './windows-zones';

export interface IcsEvent {
  uid: string;
  title: string;
  location: string | null;
  /** 'YYYY-MM-DDTHH:mm' in `tz`, or 'YYYY-MM-DD' when all_day. */
  start: string;
  /** Same form as start; exclusive for all-day events. */
  end: string;
  all_day: boolean;
  tz: string | null;
  rrule: string | null;
  exdates: string[];
  recurrence_id: string | null;
  cancelled: boolean;
  busy: boolean;
}

export interface IcsCalendar {
  name: string | null;
  events: IcsEvent[];
  warnings: string[];
}

export interface ParseOptions {
  maxEvents?: number;
  defaultTz?: string;
}

const MAX_INPUT_CHARS = 5 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 5000;
const MAX_TEXT = 200;
const MAX_WARNINGS = 100;
const MAX_EXDATES = 5000;
const MAX_EVENT_PROPS = 5000;
const MAX_PARAMS = 20;
const MAX_DEPTH = 16;
const MAX_DURATION_MINUTES = 5 * 525_600;

const RRULE_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
]);

/** VEVENT properties the importer reads; others are dropped while parsing. */
const USED_EVENT_PROPS = new Set([
  'UID',
  'SUMMARY',
  'LOCATION',
  'DTSTART',
  'DTEND',
  'DURATION',
  'DUE',
  'RRULE',
  'EXDATE',
  'RECURRENCE-ID',
  'STATUS',
  'TRANSP',
]);

interface Prop {
  name: string;
  params: Map<string, string>;
  value: string;
}

/** A parsed DATE / DATE-TIME value. `wall` is 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm'. */
interface Parsed {
  allDay: boolean;
  wall: string;
  tz: string | null;
}

interface Ctx {
  defaultTz: string;
  warn: (message: string) => void;
  badZones: Set<string>;
}

// ---------------------------------------------------------------- lines ----

function unfold(text: string): string[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[] = [];
  let current: string | null = null;
  for (const line of src.split(/\r\n|\n|\r/)) {
    const c = line.charCodeAt(0);
    if ((c === 32 || c === 9) && current !== null) {
      current += line.slice(1);
    } else {
      if (current !== null) out.push(current);
      current = line;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const parts: string[] = [];
  let inQuote = false;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === sep && !inQuote) {
      parts.push(s.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(s.slice(from));
  return parts;
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function parseLine(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 34) inQuote = !inQuote;
    else if (c === 58 && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const segments = splitOutsideQuotes(line.slice(0, colon), ';');
  const name = (segments[0] ?? '').trim().toUpperCase();
  if (!name) return null;
  const params = new Map<string, string>();
  for (const seg of segments.slice(1, MAX_PARAMS + 1)) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const key = seg.slice(0, eq).trim().toUpperCase();
    if (!params.has(key)) params.set(key, unquote(seg.slice(eq + 1).trim()));
  }
  return { name, params, value: line.slice(colon + 1) };
}

// ----------------------------------------------------------------- text ----

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function unescapeText(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function textOf(prop: Prop | undefined): string {
  return prop ? clip(unescapeText(prop.value).trim(), MAX_TEXT) : '';
}

// ---------------------------------------------------------------- zones ----

function validIana(tz: string): boolean {
  return tz.length > 0 && tz.length <= 64 && !/^[+-]/.test(tz) && isTimeZone(tz);
}

/** IANA zone for a TZID-ish name, or null if it cannot be resolved. */
function resolveZoneName(raw: string): string | null {
  const name = unquote(raw.trim());
  if (!name) return null;
  if (validIana(name)) return name;
  const windows = windowsToIana(name);
  if (windows && validIana(windows)) return windows;
  if (name.includes('/')) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const candidate = parts.slice(i).join('/');
      if (validIana(candidate)) return candidate;
    }
  }
  return null;
}

function resolveTzid(raw: string, ctx: Ctx): string {
  const zone = resolveZoneName(raw);
  if (zone) return zone;
  const key = raw.slice(0, 80);
  if (!ctx.badZones.has(key)) {
    ctx.badZones.add(key);
    ctx.warn(`Unknown time zone "${key}"; using ${ctx.defaultTz}`);
  }
  return ctx.defaultTz;
}

// ---------------------------------------------------------------- dates ----

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1000 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseDateValue(value: string, params: Map<string, string>, ctx: Ctx): Parsed | null {
  const v = value.trim().toUpperCase();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const y = m[1] ?? '';
  const mo = m[2] ?? '';
  const d = m[3] ?? '';
  if (!validDate(Number(y), Number(mo), Number(d))) return null;
  const date = `${y}-${mo}-${d}`;
  if (m[4] === undefined) return { allDay: true, wall: date, tz: null };
  const h = m[4];
  const mi = m[5] ?? '';
  if (Number(h) > 23 || Number(mi) > 59) return null;
  const wall = `${date}T${h}:${mi}`;
  if (m[7]) return { allDay: false, wall, tz: 'UTC' };
  const tzid = params.get('TZID');
  return { allDay: false, wall, tz: tzid ? resolveTzid(tzid, ctx) : ctx.defaultTz };
}

/** Express `p` in the form used by an event: a date, or a wall time in `tz`. */
function coerce(p: Parsed, allDay: boolean, tz: string | null, refTime: string): string {
  if (allDay) return p.wall.slice(0, 10);
  if (p.allDay) return `${p.wall}T${refTime}`;
  if (tz === null || p.tz === null || p.tz === tz) return p.wall;
  return toWall(toInstant(p.wall, p.tz), tz);
}

/** Minutes for a non-negative RFC 5545 DURATION, or null. */
function parseDuration(value: string): number | null {
  const m =
    /^\+?P(?:(\d{1,7})W)?(?:(\d{1,7})D)?(?:T(?:(\d{1,7})H)?(?:(\d{1,7})M)?(?:(\d{1,7})S)?)?$/i.exec(
      value.trim(),
    );
  if (!m || value.trim().endsWith('T') || /^\+?P$/i.test(value.trim())) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const minutes = n(1) * 10_080 + n(2) * 1440 + n(3) * 60 + n(4) + Math.floor(n(5) / 60);
  return Math.min(minutes, MAX_DURATION_MINUTES);
}

// ---------------------------------------------------------------- rrule ----

function sanitizeRRule(value: string, warn: (m: string) => void): string | null {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const part of value.trim().split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    let val = part
      .slice(eq + 1)
      .trim()
      .toUpperCase();
    if (!RRULE_PARTS.has(key)) {
      if (key !== 'DTSTART' && key !== 'TZID') warn(`Ignored unsupported RRULE part ${key}`);
      continue;
    }
    if (seen.has(key) || !val) continue;
    seen.add(key);
    if (key === 'INTERVAL' && !/^[1-9]\d{0,3}$/.test(val)) return null;
    if (key === 'COUNT' && !/^[1-9]\d{0,5}$/.test(val)) return null;
    if (key === 'UNTIL') {
      if (!/^\d{8}(T\d{6}Z?)?$/.test(val)) return null;
      // A bare date means "through the end of that day".
      if (val.length === 8) val = `${val}T235959Z`;
    }
    kept.push(`${key}=${val}`);
  }
  const rule = kept.join(';');
  return isValidRRule(rule) ? rule : null;
}

// --------------------------------------------------------------- events ----

interface Built {
  event: IcsEvent;
  /** RECURRENCE-ID as written, re-expressed against the master afterwards. */
  rid: Parsed | null;
}

function buildEvent(props: Prop[], ctx: Ctx): Built | null {
  const first = (name: string) => props.find((p) => p.name === name);
  const title = textOf(first('SUMMARY'));
  const locText = textOf(first('LOCATION'));
  const rawUid = first('UID')?.value.trim() ?? '';
  const label = (rawUid || title || '(untitled)').slice(0, 60);
  const warn = (m: string) => ctx.warn(`Event "${label}": ${m}`);

  const dtstart = first('DTSTART');
  const startP = dtstart ? parseDateValue(dtstart.value, dtstart.params, ctx) : null;
  if (!dtstart || !startP) {
    warn(dtstart ? 'invalid DTSTART, skipped' : 'missing DTSTART, skipped');
    return null;
  }
  const allDay = startP.allDay;
  const tz = allDay ? null : startP.tz;
  const start = startP.wall;
  const refTime = allDay ? '00:00' : start.slice(11, 16);

  let end: string | null = null;
  const dtend = first('DTEND') ?? first('DUE');
  if (dtend) {
    const endP = parseDateValue(dtend.value, dtend.params, ctx);
    if (!endP) warn('invalid DTEND ignored');
    else if (!allDay && endP.allDay) warn('DTEND is a date but DTSTART is a time; DTEND ignored');
    else end = coerce(endP, allDay, tz, refTime);
  }
  const durationProp = first('DURATION');
  if (end === null && durationProp) {
    const minutes = parseDuration(durationProp.value);
    if (minutes !== null) {
      end = allDay
        ? addDays(start, Math.max(1, Math.ceil(minutes / 1440)))
        : addWallMinutes(start, minutes);
    }
  }
  if (allDay) {
    if (end === null || end <= start) end = addDays(start, 1);
  } else if (end === null || end < start) {
    end = start;
  }

  let rrule: string | null = null;
  const rruleProp = first('RRULE');
  if (rruleProp) {
    rrule = sanitizeRRule(rruleProp.value, warn);
    if (!rrule) warn('unsupported RRULE; only the first occurrence is kept');
  }

  const exdates = new Set<string>();
  for (const p of props) {
    if (p.name !== 'EXDATE') continue;
    for (const v of p.value.split(',')) {
      if (exdates.size >= MAX_EXDATES) break;
      const parsed = parseDateValue(v, p.params, ctx);
      if (parsed) exdates.add(coerce(parsed, allDay, tz, refTime));
    }
  }

  let rid: Parsed | null = null;
  let recurrenceId: string | null = null;
  const ridProp = first('RECURRENCE-ID');
  if (ridProp) {
    rid = parseDateValue(ridProp.value, ridProp.params, ctx);
    if (!rid) {
      warn('invalid RECURRENCE-ID, skipped');
      return null;
    }
    recurrenceId = coerce(rid, allDay, tz, refTime);
  }

  return {
    rid,
    event: {
      uid: clip(rawUid, 255) || `${start}|${title}`,
      title,
      location: locText || null,
      start,
      end,
      all_day: allDay,
      tz,
      rrule,
      exdates: [...exdates],
      recurrence_id: recurrenceId,
      cancelled: (first('STATUS')?.value.trim().toUpperCase() ?? '') === 'CANCELLED',
      busy: (first('TRANSP')?.value.trim().toUpperCase() ?? '') !== 'TRANSPARENT',
    },
  };
}

// ----------------------------------------------------------------- main ----

function parseInner(text: string, opts: ParseOptions, warnings: string[]): IcsCalendar {
  let suppressed = false;
  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (!suppressed) {
      suppressed = true;
      warnings.push('Further warnings suppressed');
    }
  };

  if (text.length > MAX_INPUT_CHARS) {
    warn('Calendar file is larger than 5 MB and was not read');
    return { name: null, events: [], warnings };
  }
  const maxEvents = Math.max(0, Math.floor(opts.maxEvents ?? DEFAULT_MAX_EVENTS));

  const stack: string[] = [];
  const calProps = new Map<string, Prop>();
  const rawEvents: Prop[][] = [];
  let current: Prop[] | null = null;
  let began = 0;
  let unbalanced = false;

  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;

    if (prop.name === 'BEGIN') {
      const comp = prop.value.trim().toUpperCase();
      if (comp === 'VEVENT' && current && stack.length === 2) {
        warn('VEVENT without END, dropped');
        current = null;
        stack.pop();
      }
      if (stack.length >= MAX_DEPTH) {
        warn('Components nested too deeply; stopped reading');
        break;
      }
      if (comp === 'VEVENT' && stack.length === 1 && stack[0] === 'VCALENDAR') {
        if (began >= maxEvents) {
          warn(`More than ${maxEvents} events; the rest were ignored`);
          break;
        }
        began++;
        current = [];
      }
      stack.push(comp);
      continue;
    }

    if (prop.name === 'END') {
      const comp = prop.value.trim().toUpperCase();
      const idx = stack.lastIndexOf(comp);
      if (idx < 0) {
        if (!unbalanced) warn(`END:${comp.slice(0, 40)} without matching BEGIN`);
        unbalanced = true;
        continue;
      }
      if (current && idx <= 1) {
        if (idx === 1) rawEvents.push(current);
        else warn('VEVENT without END, dropped');
        current = null;
      }
      stack.length = idx;
      continue;
    }

    if (current && stack.length === 2 && stack[1] === 'VEVENT') {
      // Only what we use: a hostile file of tiny unknown properties can't
      // fill memory (security review 0004, L6).
      if (USED_EVENT_PROPS.has(prop.name) && current.length < MAX_EVENT_PROPS) current.push(prop);
    } else if (stack.length === 1 && stack[0] === 'VCALENDAR' && !calProps.has(prop.name)) {
      calProps.set(prop.name, prop);
    }
  }
  if (current) warn('VEVENT without END, dropped');

  const calName = clip(
    unescapeText((calProps.get('X-WR-CALNAME') ?? calProps.get('NAME'))?.value ?? '').trim(),
    MAX_TEXT,
  );

  let defaultTz = 'UTC';
  const wrTz = calProps.get('X-WR-TIMEZONE')?.value ?? '';
  const fromOpts = opts.defaultTz ? resolveZoneName(opts.defaultTz) : null;
  const fromFeed = fromOpts ? null : resolveZoneName(wrTz);
  defaultTz = fromOpts ?? fromFeed ?? 'UTC';

  const ctx: Ctx = { defaultTz, warn, badZones: new Set() };
  const built: Built[] = [];
  for (const props of rawEvents) {
    try {
      const b = buildEvent(props, ctx);
      if (b) built.push(b);
    } catch {
      warn('Event could not be read and was skipped');
    }
  }

  // Express each override's RECURRENCE-ID in its master's zone.
  const masters = new Map<string, IcsEvent>();
  for (const { event } of built) {
    if (!event.recurrence_id && !masters.has(event.uid)) masters.set(event.uid, event);
  }
  for (const { event, rid } of built) {
    const master = rid ? masters.get(event.uid) : undefined;
    if (rid && master) {
      const refTime = master.all_day ? '00:00' : master.start.slice(11, 16);
      try {
        event.recurrence_id = coerce(rid, master.all_day, master.tz, refTime);
      } catch {
        warn('RECURRENCE-ID could not be converted');
      }
    }
  }

  return { name: calName || null, events: built.map((b) => b.event), warnings };
}

/** Parse iCalendar text. Never throws. */
export function parseIcs(text: string, opts: ParseOptions = {}): IcsCalendar {
  const warnings: string[] = [];
  try {
    return parseInner(text, opts, warnings);
  } catch {
    return { name: null, events: [], warnings: [...warnings, 'Calendar could not be parsed'] };
  }
}

/** A subscription URL we are willing to fetch: https (webcal is mapped to it) or http. */
export function normalizeFeedUrl(input: string): string | null {
  if (typeof input !== 'string') return null;
  const t = input.trim();
  if (!t || t.length > 2048 || /\s/.test(t)) return null;
  const m = /^(webcals?|https?):\/\/(.+)$/i.exec(t);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  if ((m[2] ?? '').startsWith('/')) return null;
  const normalized = scheme.startsWith('webcal') ? `https://${m[2] ?? ''}` : t;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || !url.hostname) return null;
  } catch {
    return null;
  }
  return normalized;
}
