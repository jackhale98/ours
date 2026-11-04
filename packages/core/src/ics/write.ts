// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * iCalendar (RFC 5545) writer for exporting our events to other calendar apps.
 *
 * Timed events are written as `DTSTART;TZID=<IANA zone>:...` with no VTIMEZONE
 * block: Google Calendar and Apple Calendar resolve IANA TZIDs on their own,
 * and we have no zone rule data to emit anyway. A TZID that is not a plain
 * IANA-looking name is not written at all; the event is skipped (simpler and
 * safer than guessing a fallback zone). Events with malformed dates are also
 * skipped. `writeIcs` never throws on bad event data.
 */

export interface IcsExportEvent {
  /** Stable id (record id); written as `${uid}@ours`. */
  uid: string;
  title: string;
  /** 'YYYY-MM-DD' (all-day) or 'YYYY-MM-DDTHH:mm' (wall clock in tz). */
  start: string;
  /** Same form as start; exclusive for all-day events. */
  end: string;
  allDay: boolean;
  /** IANA zone for timed events (null only for all-day). */
  tz: string | null;
  /** RRULE value without the 'RRULE:' prefix, passed through verbatim. */
  rrule: string | null;
  /**
   * Days of the series changed on their own (same forms as start/end):
   * skipped ones are written as EXDATE, moved ones as an extra VEVENT with
   * the same UID and a RECURRENCE-ID naming the original day (RFC 5545 §3.8.4.4).
   */
  except?: { at: string; to: { start: string; end: string } | null }[];
  location?: string | null;
  description?: string | null;
  status?: 'confirmed' | 'tentative';
  /** ms epoch; written as DTSTAMP and LAST-MODIFIED in UTC. */
  updatedAt: number;
}

const DEFAULT_PRODID = '-//Ours//Ours//EN';
const MAX_LINE_OCTETS = 75;
const TZID_RE = /^[A-Za-z0-9_+\-/]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const encoder = new TextEncoder();

// ----------------------------------------------------------------- text ----

/** TEXT value escaping (RFC 5545 §3.3.11); other control characters are dropped. */
function escapeText(s: string): string {
  return (
    s
      .replace(/\r\n|\r/g, '\n')
      // Control characters except TAB and LF, and unpaired surrogates.
      .replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
        /[\u0000-\u0008\u000b-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
        '',
      )
      .replace(/\\|;|,/g, (c) => `\\${c}`)
      .replace(/\n/g, '\\n')
  );
}

/** Remove every control character (for values that are not TEXT, e.g. UID, RRULE). */
function stripControls(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return s.replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * Fold a content line at 75 octets (UTF-8 bytes) with CRLF + space, never
 * splitting a code point. Continuation lines carry a leading space, so they
 * hold 74 octets of content.
 */
function fold(line: string): string {
  let out = '';
  let octets = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (octets + size > MAX_LINE_OCTETS) {
      out += '\r\n ';
      octets = 1;
    }
    out += ch;
    octets += size;
  }
  return out;
}

// ---------------------------------------------------------------- dates ----

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 'YYYYMMDD' for a valid 'YYYY-MM-DD', else null. */
function dateValue(s: unknown): string | null {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) return null;
  return validDate(Number(m[1]), Number(m[2]), Number(m[3])) ? `${m[1]}${m[2]}${m[3]}` : null;
}

/** 'YYYYMMDDTHHMM00' for a valid 'YYYY-MM-DDTHH:mm', else null. */
function dateTimeValue(s: unknown): string | null {
  const m = typeof s === 'string' ? DATETIME_RE.exec(s) : null;
  if (!m) return null;
  if (!validDate(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  if (Number(m[4]) > 23 || Number(m[5]) > 59) return null;
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00`;
}

/** UTC 'YYYYMMDDTHHMMSSZ' for a ms epoch (epoch 0 if not a usable timestamp). */
function utcStamp(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  const safe = Number.isNaN(d.getTime()) ? new Date(0) : d;
  return safe
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

// --------------------------------------------------------------- events ----

function eventLines(e: IcsExportEvent): string[] | null {
  const uid = stripControls(String(e.uid ?? '')).trim();
  if (!uid) return null;

  if (!e.allDay && (typeof e.tz !== 'string' || !TZID_RE.test(e.tz))) return null;
  /** A date property in this event's form ('DTSTART', 'EXDATE', ...), or null if malformed. */
  const prop = (name: string, value: string): string | null => {
    if (e.allDay) {
      const d = dateValue(value);
      return d ? `${name};VALUE=DATE:${d}` : null;
    }
    const d = dateTimeValue(value);
    return d ? `${name};TZID=${e.tz}:${d}` : null;
  };
  const dtstart = prop('DTSTART', e.start);
  const dtend = prop('DTEND', e.end);
  if (!dtstart || !dtend) return null;

  const stamp = utcStamp(e.updatedAt);
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}@ours`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    dtstart,
    dtend,
    `SUMMARY:${escapeText(String(e.title ?? ''))}`,
  ];
  const rrule = typeof e.rrule === 'string' ? stripControls(e.rrule).trim() : '';
  const details: string[] = [];
  if (e.location) details.push(`LOCATION:${escapeText(e.location)}`);
  if (e.description) details.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.status === 'confirmed') details.push('STATUS:CONFIRMED');
  else if (e.status === 'tentative') details.push('STATUS:TENTATIVE');
  const overrides: string[] = [];
  if (rrule) {
    lines.push(`RRULE:${rrule}`);
    for (const x of (Array.isArray(e.except) ? e.except : []).slice(0, 500)) {
      if (!x.to) {
        const exdate = prop('EXDATE', x.at);
        if (exdate) lines.push(exdate);
        continue;
      }
      const rid = prop('RECURRENCE-ID', x.at);
      const s = prop('DTSTART', x.to.start);
      const en = prop('DTEND', x.to.end);
      if (!rid || !s || !en) continue;
      overrides.push(
        'BEGIN:VEVENT',
        `UID:${uid}@ours`,
        `DTSTAMP:${stamp}`,
        rid,
        s,
        en,
        `SUMMARY:${escapeText(String(e.title ?? ''))}`,
        ...details,
        'END:VEVENT',
      );
    }
  }
  lines.push(...details, 'END:VEVENT', ...overrides);
  return lines;
}

/** Serialize events as an iCalendar document (CRLF line endings, folded at 75 octets). */
export function writeIcs(
  events: readonly IcsExportEvent[],
  opts: { name: string; prodId?: string },
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${stripControls(opts.prodId ?? DEFAULT_PRODID)}`,
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(opts.name)}`,
  ];
  for (const e of events) {
    try {
      const block = eventLines(e);
      if (block) lines.push(...block);
    } catch {
      // Malformed event: skip it rather than fail the whole export.
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
