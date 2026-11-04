// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isTimeZone } from '../schema/records';
import { toInstant, toWall } from '../time/zones';
import {
  type IcsCalendar,
  type IcsEvent,
  icsOccurrences,
  normalizeFeedUrl,
  parseIcs,
  WINDOWS_ZONES,
  windowsToIana,
} from './index';

const crlf = (s: string) => `${s.trim().split('\n').join('\r\n')}\r\n`;

const GOOGLE = crlf(`
BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Our Plans
X-WR-TIMEZONE:America/New_York
BEGIN:VTIMEZONE
TZID:America/New_York
X-LIC-LOCATION:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20250303T190000
DTEND;TZID=America/New_York:20250303T203000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=America/New_York:20250317T190000
DTSTAMP:20250101T000000Z
UID:weekly-dinner@google.com
SUMMARY:Dinner
LOCATION:Luigi's\\, 5th Ave
STATUS:CONFIRMED
TRANSP:OPAQUE
BEGIN:VALARM
TRIGGER:-PT30M
ACTION:DISPLAY
SUMMARY:Wrong alarm title
DESCRIPTION:Reminder
END:VALARM
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20250326T180000
DTEND;TZID=America/New_York:20250326T193000
RECURRENCE-ID;TZID=America/New_York:20250324T190000
UID:weekly-dinner@google.com
SUMMARY:Dinner (moved)
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20250331T190000
DTEND;TZID=America/New_York:20250331T203000
RECURRENCE-ID;TZID=America/New_York:20250331T190000
UID:weekly-dinner@google.com
SUMMARY:Dinner
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20250412
DTEND;VALUE=DATE:20250414
UID:trip@google.com
SUMMARY:Anniversary trip
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR
`);

const OUTLOOK = crlf(`
BEGIN:VCALENDAR
METHOD:PUBLISH
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
X-WR-CALNAME:Work
BEGIN:VTIMEZONE
TZID:Pacific Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
CLASS:PUBLIC
DTSTART;TZID="Pacific Standard Time":20250505T100000
DURATION:PT1H30M
RRULE:FREQ=DAILY;COUNT=3;BYHOUR=10
UID:040000008200E00074C5B7101A82E008
SUMMARY:Planning
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=W. Europe Standard Time:20250506T090000
DTEND;TZID=W. Europe Standard Time:20250506T100000
UID:outlook-2
SUMMARY:Berlin sync
END:VEVENT
END:VCALENDAR
`);

const APPLE = crlf(`
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//macOS 14.0//EN
X-WR-CALNAME:Home
BEGIN:VEVENT
UID:APPLE-1
DTSTART:20250601T120000
DTEND:20250601T130000
SUMMARY:Lunch
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR
`);

const wrap = (body: string) => `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR\n`;
const vevent = (body: string) => wrap(`BEGIN:VEVENT\n${body}\nEND:VEVENT`);
const one = (body: string, opts?: Parameters<typeof parseIcs>[1]): IcsEvent => {
  const ev = parseIcs(vevent(body), opts).events[0];
  if (!ev) throw new Error('no event parsed');
  return ev;
};

const NY = 'America/New_York';
const day = (date: string, tz = NY) => toInstant(`${date}T00:00`, tz);

describe('parseIcs: Google export', () => {
  const cal = parseIcs(GOOGLE);
  const master = cal.events.find((e) => e.uid === 'weekly-dinner@google.com' && !e.recurrence_id);

  it('reads calendar name and all VEVENTs but not the VTIMEZONE', () => {
    expect(cal.name).toBe('Our Plans');
    expect(cal.events).toHaveLength(4);
    expect(cal.warnings).toEqual([]);
  });

  it('parses the recurring master with EXDATE', () => {
    expect(master).toMatchObject({
      title: 'Dinner',
      location: "Luigi's, 5th Ave",
      start: '2025-03-03T19:00',
      end: '2025-03-03T20:30',
      tz: NY,
      all_day: false,
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      exdates: ['2025-03-17T19:00'],
      recurrence_id: null,
      cancelled: false,
      busy: true,
    });
  });

  it('ignores properties of the nested VALARM', () => {
    expect(master?.title).toBe('Dinner');
  });

  it('parses overrides and cancelled overrides', () => {
    const moved = cal.events.find((e) => e.title === 'Dinner (moved)');
    expect(moved?.recurrence_id).toBe('2025-03-24T19:00');
    expect(moved?.start).toBe('2025-03-26T18:00');
    const cancelled = cal.events.find((e) => e.cancelled);
    expect(cancelled?.recurrence_id).toBe('2025-03-31T19:00');
  });

  it('parses the all-day transparent event', () => {
    expect(cal.events.find((e) => e.uid === 'trip@google.com')).toMatchObject({
      all_day: true,
      tz: null,
      start: '2025-04-12',
      end: '2025-04-14',
      busy: false,
    });
  });
});

describe('parseIcs: Outlook and Apple exports', () => {
  it('maps Windows zone names and DURATION; drops BYHOUR with a warning', () => {
    const cal = parseIcs(OUTLOOK);
    const [planning, berlin] = cal.events;
    expect(planning).toMatchObject({
      tz: 'America/Los_Angeles',
      start: '2025-05-05T10:00',
      end: '2025-05-05T11:30',
      rrule: 'FREQ=DAILY;COUNT=3',
    });
    expect(berlin?.tz).toBe('Europe/Berlin');
    expect(cal.warnings.some((w) => w.includes('BYHOUR'))).toBe(true);
  });

  it('puts floating times in the default zone (UTC when none is known)', () => {
    const ev = parseIcs(APPLE).events[0];
    expect(ev).toMatchObject({ tz: 'UTC', start: '2025-06-01T12:00', busy: false });
  });

  it.each([
    ['opts.defaultTz', 'Europe/London', undefined, 'Europe/London'],
    ['X-WR-TIMEZONE', undefined, 'Asia/Tokyo', 'Asia/Tokyo'],
    ['Windows X-WR-TIMEZONE', undefined, 'Tokyo Standard Time', 'Asia/Tokyo'],
    ['invalid X-WR-TIMEZONE', undefined, 'Nowhere/Land', 'UTC'],
    ['opts wins over feed', 'Europe/Paris', 'Asia/Tokyo', 'Europe/Paris'],
  ])('default zone from %s', (_n, optTz, feedTz, expected) => {
    const header = feedTz ? `X-WR-TIMEZONE:${feedTz}\n` : '';
    const text = `BEGIN:VCALENDAR\n${header}BEGIN:VEVENT\nDTSTART:20250101T090000\nEND:VEVENT\nEND:VCALENDAR`;
    const cal = parseIcs(text, optTz ? { defaultTz: optTz } : {});
    expect(cal.events[0]?.tz).toBe(expected);
  });

  it('applies X-WR-TIMEZONE even when it appears after the events', () => {
    const text =
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20250101T090000\nEND:VEVENT\nX-WR-TIMEZONE:Asia/Tokyo\nEND:VCALENDAR';
    expect(parseIcs(text).events[0]?.tz).toBe('Asia/Tokyo');
  });
});

describe('parseIcs: text and line handling', () => {
  it('unfolds long SUMMARY and unescapes \\, ; \\n \\\\', () => {
    const text = crlf(
      `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20250101T090000Z\nSUMMARY:Dinner\\, drinks; and a very long\n  title that continues\n \\non the next line \\\\ done\nEND:VEVENT\nEND:VCALENDAR`,
    );
    expect(parseIcs(text).events[0]?.title).toBe(
      'Dinner, drinks; and a very long title that continues\non the next line \\ done',
    );
  });

  it('unfolds tab continuations and accepts LF and a BOM', () => {
    const text = `\uFEFFBEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20250101T090000Z\nSUMMARY:Ab\n\tcd\nEND:VEVENT\nEND:VCALENDAR`;
    expect(parseIcs(text).events[0]?.title).toBe('Abcd');
  });

  it('accepts lone CR line endings', () => {
    const text =
      'BEGIN:VCALENDAR\rBEGIN:VEVENT\rDTSTART:20250101T090000Z\rSUMMARY:CR\rEND:VEVENT\rEND:VCALENDAR';
    expect(parseIcs(text).events[0]?.title).toBe('CR');
  });

  it('treats names case-insensitively and splits at the first unquoted colon', () => {
    const ev = one('dtstart;tzid="America/New_York":20250101T090000\nsummary:a:b:c');
    expect(ev.start).toBe('2025-01-01T09:00');
    expect(ev.tz).toBe(NY);
    expect(ev.title).toBe('a:b:c');
  });

  it('handles quoted parameter values containing colons and semicolons', () => {
    const ev = one(
      'DTSTART;X-FOO="a:b;c";TZID=Europe/Paris:20250101T090000\nSUMMARY;LANGUAGE=en:Hi',
    );
    expect(ev.tz).toBe('Europe/Paris');
    expect(ev.title).toBe('Hi');
  });

  it('clips title and location to 200 characters without splitting surrogates', () => {
    const long = 'x'.repeat(500);
    const ev = one(`DTSTART:20250101T090000Z\nSUMMARY:${long}\nLOCATION:${long}`);
    expect(ev.title).toHaveLength(200);
    expect(ev.location).toHaveLength(200);
    const emoji = one(`DTSTART:20250101T090000Z\nSUMMARY:${'x'.repeat(199)}\u{1F600}`);
    expect(emoji.title).toBe('x'.repeat(199));
  });

  it('allows an empty or missing title, and trims it', () => {
    expect(one('DTSTART:20250101T090000Z').title).toBe('');
    expect(one('DTSTART:20250101T090000Z\nSUMMARY:   hi  ').title).toBe('hi');
  });

  it('reads calendar NAME when X-WR-CALNAME is absent; null when blank', () => {
    expect(parseIcs('BEGIN:VCALENDAR\nNAME:Fallback\nEND:VCALENDAR').name).toBe('Fallback');
    expect(parseIcs('BEGIN:VCALENDAR\nX-WR-CALNAME:  \nEND:VCALENDAR').name).toBeNull();
  });

  it('ignores VTODO, VJOURNAL and events outside VCALENDAR', () => {
    const text = `BEGIN:VEVENT\nDTSTART:20250101T090000Z\nEND:VEVENT\nBEGIN:VCALENDAR\nBEGIN:VTODO\nDTSTART:20250101T090000Z\nSUMMARY:todo\nEND:VTODO\nBEGIN:VJOURNAL\nDTSTART:20250101T090000Z\nEND:VJOURNAL\nEND:VCALENDAR`;
    expect(parseIcs(text).events).toEqual([]);
  });

  it('ignores lines without a colon', () => {
    expect(one('DTSTART:20250101T090000Z\ngarbage line').start).toBe('2025-01-01T09:00');
  });
});

describe('parseIcs: date and time forms', () => {
  it.each([
    ['UTC Z', 'DTSTART:20250115T143000Z', '2025-01-15T14:30', 'UTC', false],
    ['lowercase z/t', 'DTSTART:20250115t143000z', '2025-01-15T14:30', 'UTC', false],
    ['TZID', 'DTSTART;TZID=Asia/Tokyo:20250115T143000', '2025-01-15T14:30', 'Asia/Tokyo', false],
    ['seconds dropped', 'DTSTART:20250115T143059Z', '2025-01-15T14:30', 'UTC', false],
    ['no seconds', 'DTSTART:20250115T1430Z', '2025-01-15T14:30', 'UTC', false],
    ['VALUE=DATE', 'DTSTART;VALUE=DATE:20250115', '2025-01-15', null, true],
    ['DATE without VALUE', 'DTSTART:20250115', '2025-01-15', null, true],
    [
      'Windows name',
      'DTSTART;TZID=Eastern Standard Time:20250115T090000',
      '2025-01-15T09:00',
      NY,
      false,
    ],
    [
      'mozilla prefix',
      'DTSTART;TZID=/mozilla.org/20070129_1/Europe/Berlin:20250115T090000',
      '2025-01-15T09:00',
      'Europe/Berlin',
      false,
    ],
  ])('DTSTART %s', (_n, line, start, tz, allDay) => {
    const ev = one(line);
    expect(ev.start).toBe(start);
    expect(ev.tz).toBe(tz);
    expect(ev.all_day).toBe(allDay);
  });

  it('falls back to the default zone for unknown TZIDs, warning once per zone', () => {
    const cal = parseIcs(
      vevent(
        'DTSTART;TZID="(UTC+01:00) Nowhere":20250115T090000\nDTEND;TZID="(UTC+01:00) Nowhere":20250115T100000',
      ),
    );
    expect(cal.events[0]?.tz).toBe('UTC');
    expect(cal.warnings.filter((w) => w.includes('Unknown time zone'))).toHaveLength(1);
  });

  it.each([
    ['bad month', 'DTSTART:20251315T090000Z'],
    ['bad day', 'DTSTART:20250230'],
    ['bad hour', 'DTSTART:20250115T250000Z'],
    ['bad minute', 'DTSTART:20250115T096000Z'],
    ['year too small', 'DTSTART:00010101'],
    ['nonsense', 'DTSTART:tomorrow'],
    ['missing', 'SUMMARY:No start'],
  ])('skips events with %s DTSTART, with a warning', (_n, body) => {
    const cal = parseIcs(vevent(body));
    expect(cal.events).toEqual([]);
    expect(cal.warnings.length).toBeGreaterThan(0);
  });

  it('converts a DTEND in a different zone into the DTSTART zone', () => {
    const ev = one(
      'DTSTART;TZID=America/New_York:20250115T090000\nDTEND;TZID=Europe/London:20250115T160000',
    );
    expect(ev.tz).toBe(NY);
    expect(ev.end).toBe('2025-01-15T11:00');
  });

  it('converts a UTC DTEND into the DTSTART zone', () => {
    const ev = one('DTSTART;TZID=America/New_York:20250115T090000\nDTEND:20250115T160000Z');
    expect(ev.end).toBe('2025-01-15T11:00');
  });

  it.each([
    ['timed without DTEND', 'DTSTART:20250115T090000Z', '2025-01-15T09:00'],
    ['all-day without DTEND', 'DTSTART;VALUE=DATE:20250115', '2025-01-16'],
    ['DURATION minutes', 'DTSTART:20250115T090000Z\nDURATION:PT45M', '2025-01-15T09:45'],
    ['DURATION hours+minutes', 'DTSTART:20250115T090000Z\nDURATION:PT1H30M', '2025-01-15T10:30'],
    ['DURATION days', 'DTSTART:20250115T090000Z\nDURATION:P1D', '2025-01-16T09:00'],
    ['DURATION weeks', 'DTSTART:20250115T090000Z\nDURATION:P1W', '2025-01-22T09:00'],
    ['all-day DURATION', 'DTSTART;VALUE=DATE:20250115\nDURATION:P3D', '2025-01-18'],
    ['negative DURATION ignored', 'DTSTART:20250115T090000Z\nDURATION:-PT15M', '2025-01-15T09:00'],
    ['junk DURATION ignored', 'DTSTART:20250115T090000Z\nDURATION:soon', '2025-01-15T09:00'],
    ['empty DURATION ignored', 'DTSTART:20250115T090000Z\nDURATION:P', '2025-01-15T09:00'],
    [
      'DTEND beats DURATION',
      'DTSTART:20250115T090000Z\nDTEND:20250115T100000Z\nDURATION:PT5H',
      '2025-01-15T10:00',
    ],
    [
      'DTEND before start clamps',
      'DTSTART:20250115T090000Z\nDTEND:20250115T080000Z',
      '2025-01-15T09:00',
    ],
    [
      'all-day DTEND == start',
      'DTSTART;VALUE=DATE:20250115\nDTEND;VALUE=DATE:20250115',
      '2025-01-16',
    ],
    [
      'all-day with timed DTEND',
      'DTSTART;VALUE=DATE:20250115\nDTEND:20250117T000000Z',
      '2025-01-17',
    ],
    [
      'timed with date DTEND ignored',
      'DTSTART:20250115T090000Z\nDTEND;VALUE=DATE:20250117',
      '2025-01-15T09:00',
    ],
    [
      'invalid DTEND falls to DURATION',
      'DTSTART:20250115T090000Z\nDTEND:oops\nDURATION:PT1H',
      '2025-01-15T10:00',
    ],
  ])('end: %s', (_n, body, end) => {
    expect(one(body).end).toBe(end);
  });
});

describe('parseIcs: UID, status, transparency', () => {
  it('uses a stable fallback UID when missing', () => {
    const ev = one('DTSTART:20250115T090000Z\nSUMMARY:Standup');
    expect(ev.uid).toBe('2025-01-15T09:00|Standup');
    expect(one('DTSTART:20250115T090000Z\nSUMMARY:Standup').uid).toBe(ev.uid);
  });

  it.each([
    ['TRANSPARENT', false],
    ['transparent', false],
    ['OPAQUE', true],
  ])('TRANSP:%s -> busy=%s', (v, busy) => {
    expect(one(`DTSTART:20250115T090000Z\nTRANSP:${v}`).busy).toBe(busy);
  });

  it('flags STATUS:CANCELLED', () => {
    expect(one('DTSTART:20250115T090000Z\nSTATUS:CANCELLED').cancelled).toBe(true);
    expect(one('DTSTART:20250115T090000Z\nSTATUS:TENTATIVE').cancelled).toBe(false);
  });
});

describe('parseIcs: RRULE and EXDATE', () => {
  it.each([
    ['plain weekly', 'FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=WEEKLY;BYDAY=MO,WE'],
    ['lowercase', 'freq=daily;count=5', 'FREQ=DAILY;COUNT=5'],
    ['DTSTART/TZID dropped', 'FREQ=DAILY;DTSTART=20250101T090000;TZID=UTC', 'FREQ=DAILY'],
    ['unsupported parts dropped', 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYWEEKNO=3', 'FREQ=WEEKLY'],
    ['UNTIL kept', 'FREQ=DAILY;UNTIL=20250201T000000Z', 'FREQ=DAILY;UNTIL=20250201T000000Z'],
    ['date UNTIL made inclusive', 'FREQ=DAILY;UNTIL=20250201', 'FREQ=DAILY;UNTIL=20250201T235959Z'],
    ['duplicates ignored', 'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY'],
    ['empty part ignored', 'FREQ=DAILY;;INTERVAL=', 'FREQ=DAILY'],
    ['bysetpos', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1'],
  ])('sanitizes %s', (_n, input, expected) => {
    expect(one(`DTSTART:20250101T090000Z\nRRULE:${input}`).rrule).toBe(expected);
  });

  it.each([
    ['HOURLY', 'FREQ=HOURLY'],
    ['MINUTELY', 'FREQ=MINUTELY;INTERVAL=15'],
    ['SECONDLY', 'FREQ=SECONDLY'],
    ['no FREQ', 'COUNT=3'],
    ['junk', 'hello'],
    ['INTERVAL=0', 'FREQ=DAILY;INTERVAL=0'],
    ['huge COUNT', 'FREQ=DAILY;COUNT=99999999'],
    ['bad UNTIL', 'FREQ=DAILY;UNTIL=soon'],
    ['bad FREQ', 'FREQ=FORTNIGHTLY'],
  ])('rejects %s rules with a warning and keeps the event', (_n, rule) => {
    const cal = parseIcs(vevent(`DTSTART:20250101T090000Z\nRRULE:${rule}`));
    expect(cal.events).toHaveLength(1);
    expect(cal.events[0]?.rrule).toBeNull();
    expect(cal.warnings.some((w) => w.includes('RRULE'))).toBe(true);
  });

  it('merges repeated and comma-separated EXDATEs, converting zones', () => {
    const ev = one(
      [
        'DTSTART;TZID=America/New_York:20250303T190000',
        'RRULE:FREQ=DAILY',
        'EXDATE;TZID=America/New_York:20250304T190000,20250305T190000',
        'EXDATE:20250307T000000Z',
        'EXDATE;VALUE=DATE:20250308',
        'EXDATE;TZID=America/New_York:20250304T190000',
        'EXDATE:garbage',
      ].join('\n'),
    );
    expect(ev.exdates).toEqual([
      '2025-03-04T19:00',
      '2025-03-05T19:00',
      '2025-03-06T19:00',
      '2025-03-08T19:00',
    ]);
  });

  it('reduces EXDATEs to dates for all-day events', () => {
    const ev = one(
      'DTSTART;VALUE=DATE:20250303\nRRULE:FREQ=DAILY\nEXDATE;VALUE=DATE:20250304,20250305\nEXDATE:20250306T000000Z',
    );
    expect(ev.exdates).toEqual(['2025-03-04', '2025-03-05', '2025-03-06']);
  });
});

describe('parseIcs: RECURRENCE-ID', () => {
  it('converts the RECURRENCE-ID into the master zone', () => {
    const text = wrap(
      [
        'BEGIN:VEVENT\nUID:a\nDTSTART;TZID=America/New_York:20250303T190000\nRRULE:FREQ=WEEKLY\nEND:VEVENT',
        'BEGIN:VEVENT\nUID:a\nDTSTART:20250311T000000Z\nRECURRENCE-ID:20250311T000000Z\nEND:VEVENT',
      ].join('\n'),
    );
    const cal = parseIcs(text);
    // 2025-03-11T00:00Z is 2025-03-10 20:00 EDT; the master's slots are 19:00, so it names a time.
    expect(cal.events[1]?.recurrence_id).toBe('2025-03-10T20:00');
    expect(cal.events[1]?.tz).toBe('UTC');
  });

  it('uses the master time for a date RECURRENCE-ID and the date for all-day masters', () => {
    const text = wrap(
      [
        'BEGIN:VEVENT\nUID:a\nDTSTART;TZID=America/New_York:20250303T190000\nRRULE:FREQ=WEEKLY\nEND:VEVENT',
        'BEGIN:VEVENT\nUID:a\nDTSTART;TZID=America/New_York:20250311T200000\nRECURRENCE-ID;VALUE=DATE:20250310\nEND:VEVENT',
        'BEGIN:VEVENT\nUID:b\nDTSTART;VALUE=DATE:20250303\nRRULE:FREQ=WEEKLY\nEND:VEVENT',
        'BEGIN:VEVENT\nUID:b\nDTSTART;VALUE=DATE:20250311\nRECURRENCE-ID:20250310T000000Z\nEND:VEVENT',
      ].join('\n'),
    );
    const ids = parseIcs(text).events.map((e) => e.recurrence_id);
    expect(ids).toEqual([null, '2025-03-10T19:00', null, '2025-03-10']);
  });

  it('skips overrides with an unreadable RECURRENCE-ID', () => {
    const cal = parseIcs(vevent('UID:a\nDTSTART:20250101T090000Z\nRECURRENCE-ID:nope'));
    expect(cal.events).toEqual([]);
    expect(cal.warnings.length).toBeGreaterThan(0);
  });
});

describe('parseIcs: hostile and malformed input', () => {
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it.each([
    ['empty string', ''],
    ['only BEGIN:VCALENDAR', 'BEGIN:VCALENDAR'],
    ['only whitespace', '   \n\t\n'],
    ['unbalanced END', 'END:VEVENT\nEND:VCALENDAR\nEND:FOO'],
    ['unterminated VEVENT', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20250101T090000Z'],
    [
      'VCALENDAR ends inside VEVENT',
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20250101T090000Z\nEND:VCALENDAR',
    ],
    ['lone quote', 'BEGIN:VCALENDAR\nDTSTART;TZID="abc:2025\nEND:VCALENDAR'],
    ['colon only', ':::\n:\n;;;:'],
  ])('%s yields no events and does not throw', (_n, text) => {
    const cal = parseIcs(text);
    expect(cal.events).toEqual([]);
  });

  it('drops a VEVENT that is never closed when another begins', () => {
    const cal = parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20250101T090000Z\nSUMMARY:lost\nBEGIN:VEVENT\nDTSTART:20250102T090000Z\nSUMMARY:kept\nEND:VEVENT\nEND:VCALENDAR',
    );
    expect(cal.events.map((e) => e.title)).toEqual(['kept']);
    expect(cal.warnings.some((w) => w.includes('without END'))).toBe(true);
  });

  it('survives random bytes', () => {
    const r = rng(42);
    for (let i = 0; i < 20; i++) {
      const s = Array.from({ length: 2000 }, () => String.fromCharCode(Math.floor(r() * 256))).join(
        '',
      );
      expect(() => parseIcs(s)).not.toThrow();
    }
  });

  it('returns a warning, not an exception, for non-string input', () => {
    const cal = parseIcs(undefined as unknown as string);
    expect(cal.events).toEqual([]);
    expect(cal.warnings).toContain('Calendar could not be parsed');
  });

  it('rejects input over 5 MB quickly', () => {
    const big = `BEGIN:VCALENDAR\n${'X-FILLER:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'.repeat(160_000)}END:VCALENDAR`;
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
    const t0 = performance.now();
    const cal = parseIcs(big);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(cal.events).toEqual([]);
    expect(cal.warnings[0]).toMatch(/5 MB/);
  });

  it('caps events at maxEvents (default 5000) with a warning', () => {
    const body = Array.from(
      { length: 6000 },
      (_, i) => `BEGIN:VEVENT\nUID:e${i}\nDTSTART:20250101T090000Z\nSUMMARY:E${i}\nEND:VEVENT`,
    ).join('\n');
    const cal = parseIcs(wrap(body));
    expect(cal.events).toHaveLength(5000);
    expect(cal.warnings.some((w) => w.includes('5000'))).toBe(true);
    expect(parseIcs(wrap(body), { maxEvents: 10 }).events).toHaveLength(10);
    expect(parseIcs(wrap(body), { maxEvents: 0 }).events).toHaveLength(0);
  });

  it('caps the number of warnings', () => {
    const body = Array.from({ length: 300 }, () => 'BEGIN:VEVENT\nSUMMARY:x\nEND:VEVENT').join(
      '\n',
    );
    const cal = parseIcs(wrap(body));
    expect(cal.warnings).toHaveLength(101);
    expect(cal.warnings.at(-1)).toBe('Further warnings suppressed');
  });

  it('stops on absurd nesting', () => {
    const cal = parseIcs(`BEGIN:VCALENDAR\n${'BEGIN:X\n'.repeat(40)}`);
    expect(cal.warnings.some((w) => w.includes('nested'))).toBe(true);
  });

  it('fuzz: 500 mutations of the Google fixture never throw and run fast', () => {
    const r = rng(7);
    const pick = (n: number) => Math.floor(r() * n);
    const junk = [
      '\r\n',
      ':',
      ';',
      '"',
      '\\',
      'BEGIN:VEVENT',
      'END:VCALENDAR',
      '\u0000',
      '\u{1F600}',
      'Z',
      'T',
    ];
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      let s = GOOGLE;
      for (let k = 0; k < 1 + pick(6); k++) {
        const at = pick(s.length);
        switch (pick(5)) {
          case 0:
            s = s.slice(0, at) + s.slice(at + pick(80));
            break;
          case 1:
            s = s.slice(0, at) + (junk[pick(junk.length)] ?? '') + s.slice(at);
            break;
          case 2:
            s = s.slice(0, at);
            break;
          case 3:
            s = s.slice(0, at) + s.slice(Math.max(0, at - pick(200)), at) + s.slice(at);
            break;
          default:
            s = s.replace(/DTSTART|RRULE|RECURRENCE-ID|EXDATE|TZID/g, (m) =>
              r() < 0.3 ? m.toLowerCase() : m,
            );
        }
      }
      const cal = parseIcs(s);
      icsOccurrences(cal, day('2025-03-01'), day('2025-05-01'), NY);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('normalizeFeedUrl', () => {
  it.each([
    ['webcal://example.com/cal.ics', 'https://example.com/cal.ics'],
    ['WEBCAL://example.com/cal.ics', 'https://example.com/cal.ics'],
    ['webcals://example.com/cal.ics', 'https://example.com/cal.ics'],
    ['webcal://x', 'https://x'],
    ['https://example.com/a.ics?token=1', 'https://example.com/a.ics?token=1'],
    ['http://example.com/a.ics', 'http://example.com/a.ics'],
    ['  https://example.com/a.ics \n', 'https://example.com/a.ics'],
  ])('accepts %j', (input, expected) => {
    expect(normalizeFeedUrl(input)).toBe(expected);
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/calendar,BEGIN:VCALENDAR'],
    ['file:///etc/passwd'],
    ['ftp://example.com/a.ics'],
    ['https://user:pass@example.com/a.ics'],
    ['https://user@example.com/a.ics'],
    ['webcal://user:pass@example.com/a.ics'],
    ['example.com/a.ics'],
    ['https://exa mple.com/a.ics'],
    ['https://'],
    ['https:///path'],
    [''],
    ['   '],
    [`https://example.com/${'a'.repeat(2048)}`],
  ])('rejects %j', (input) => {
    expect(normalizeFeedUrl(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizeFeedUrl(null as unknown as string)).toBeNull();
  });
});

describe('windows zones', () => {
  it('has at least 45 entries and the common ones', () => {
    expect(Object.keys(WINDOWS_ZONES).length).toBeGreaterThanOrEqual(45);
    expect(windowsToIana('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(windowsToIana('romance standard time')).toBe('Europe/Paris');
    expect(windowsToIana('AUS Eastern Standard Time')).toBe('Australia/Sydney');
    expect(windowsToIana('India Standard Time')).toBe('Asia/Kolkata');
    expect(windowsToIana('Mars Standard Time')).toBeNull();
  });

  it('maps every entry to a zone the runtime knows', () => {
    for (const [name, iana] of Object.entries(WINDOWS_ZONES)) {
      expect(isTimeZone(iana), `${name} -> ${iana}`).toBe(true);
    }
  });
});

describe('icsOccurrences', () => {
  const cal = parseIcs(GOOGLE);
  const range = (a: string, b: string) => [day(a), day(b)] as const;
  const starts = (c: IcsCalendar, a: string, b: string, max?: number) =>
    icsOccurrences(c, ...range(a, b), NY, max === undefined ? {} : { max }).map((o) =>
      toWall(o.start, NY),
    );

  it('applies EXDATE, moves one occurrence and removes a cancelled one', () => {
    const titles = icsOccurrences(cal, ...range('2025-03-01', '2025-04-08'), NY)
      .filter((o) => o.uid === 'weekly-dinner@google.com')
      .map((o) => `${toWall(o.start, NY)} ${o.title}`);
    expect(titles).toEqual([
      '2025-03-03T19:00 Dinner',
      // 03-10 regular
      '2025-03-10T19:00 Dinner',
      // 03-17 excluded; 03-24 moved to Wednesday 18:00; 03-31 cancelled
      '2025-03-26T18:00 Dinner (moved)',
      '2025-04-07T19:00 Dinner',
    ]);
  });

  it('keeps wall time across the DST change', () => {
    const occ = icsOccurrences(cal, ...range('2025-03-01', '2025-03-12'), NY).filter(
      (o) => o.uid === 'weekly-dinner@google.com',
    );
    expect(occ.map((o) => toWall(o.start, NY))).toEqual(['2025-03-03T19:00', '2025-03-10T19:00']);
    // 03-09 is spring forward: Monday 03-03 is UTC-5, Monday 03-10 is UTC-4.
    expect(occ[0]?.start).toBe(Date.UTC(2025, 2, 4, 0, 0));
    expect(occ[1]?.start).toBe(Date.UTC(2025, 2, 10, 23, 0));
  });

  it('includes an override that moves into range even if the original was outside', () => {
    const [from, to] = range('2025-03-26', '2025-03-27');
    const occ = icsOccurrences(cal, from, to, NY);
    expect(occ.map((o) => o.title)).toEqual(['Dinner (moved)']);
  });

  it('drops an occurrence whose override moved it out of range', () => {
    const [from, to] = range('2025-03-24', '2025-03-25');
    expect(icsOccurrences(cal, from, to, NY)).toEqual([]);
  });

  it('removes only the cancelled instance', () => {
    expect(starts(cal, '2025-03-31', '2025-04-01')).toEqual([]);
    expect(starts(cal, '2025-04-07', '2025-04-08')).toEqual(['2025-04-07T19:00']);
  });

  it('honors range bounds as [from, to) with overlap', () => {
    const at = toInstant('2025-03-03T19:00', NY);
    const end = toInstant('2025-03-03T20:30', NY);
    expect(icsOccurrences(cal, at, at, NY)).toEqual([]);
    expect(icsOccurrences(cal, at, at + 1, NY)).toHaveLength(1);
    expect(icsOccurrences(cal, at - 1, at, NY)).toEqual([]);
    expect(icsOccurrences(cal, end - 1, end + 1, NY)).toHaveLength(1);
    expect(icsOccurrences(cal, end, end + 1, NY)).toEqual([]);
    expect(icsOccurrences(cal, end, at, NY)).toEqual([]);
    expect(icsOccurrences(cal, Number.NaN, at, NY)).toEqual([]);
  });

  it('flags transparent events instead of dropping them, and places all-day events in the viewer zone', () => {
    const occ = icsOccurrences(cal, ...range('2025-04-01', '2025-05-01'), NY).filter(
      (o) => o.uid === 'trip@google.com',
    );
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({
      busy: false,
      all_day: true,
      localStart: '2025-04-12',
      start: day('2025-04-12'),
      end: day('2025-04-14'),
    });
    const tokyo = icsOccurrences(cal, 0, Date.UTC(2030, 0, 1), 'Asia/Tokyo').find(
      (o) => o.uid === 'trip@google.com',
    );
    expect(tokyo?.start).toBe(day('2025-04-12', 'Asia/Tokyo'));
  });

  it('respects the max cap and returns the earliest occurrences', () => {
    const daily = parseIcs(
      vevent('UID:d\nDTSTART:20250101T090000Z\nRRULE:FREQ=DAILY\nSUMMARY:Daily'),
    );
    const occ = icsOccurrences(daily, Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1), 'UTC', {
      max: 10,
    });
    expect(occ).toHaveLength(10);
    expect(occ[9]?.localStart).toBe('2025-01-10T09:00');
    expect(
      icsOccurrences(daily, Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1), 'UTC', { max: 0 }),
    ).toEqual([]);
    expect(
      icsOccurrences(daily, Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1), 'UTC').length,
    ).toBeLessThanOrEqual(2000);
  });

  it('bounds work on huge feeds and sorts by start', () => {
    const body = Array.from(
      { length: 800 },
      (_, i) =>
        `BEGIN:VEVENT\nUID:u${i}\nDTSTART:2025010${1 + (i % 9)}T0${i % 10}0000Z\nRRULE:FREQ=DAILY\nEND:VEVENT`,
    ).join('\n');
    const big = parseIcs(wrap(body));
    const occ = icsOccurrences(big, Date.UTC(2025, 0, 1), Date.UTC(2025, 6, 1), 'UTC', { max: 50 });
    expect(occ).toHaveLength(50);
    expect(occ.map((o) => o.start)).toEqual([...occ.map((o) => o.start)].sort((a, b) => a - b));
  });

  it('shows an override whose master is not in the feed', () => {
    const lone = parseIcs(
      vevent('UID:x\nDTSTART:20250310T100000Z\nRECURRENCE-ID:20250309T100000Z\nSUMMARY:Lonely'),
    );
    expect(icsOccurrences(lone, Date.UTC(2025, 2, 1), Date.UTC(2025, 3, 1), 'UTC')).toHaveLength(1);
  });

  it('treats zero-length timed events as instants and handles unusable rules', () => {
    const zero = parseIcs(vevent('UID:z\nDTSTART:20250310T100000Z\nSUMMARY:Ping'));
    expect(icsOccurrences(zero, Date.UTC(2025, 2, 10), Date.UTC(2025, 2, 11), 'UTC')).toHaveLength(
      1,
    );
    expect(
      icsOccurrences(zero, Date.UTC(2025, 2, 10, 10, 0, 1), Date.UTC(2025, 2, 11), 'UTC'),
    ).toEqual([]);
    const bad = parseIcs(vevent('UID:b\nDTSTART:20250310T100000Z\nRRULE:FREQ=HOURLY'));
    expect(icsOccurrences(bad, Date.UTC(2025, 2, 1), Date.UTC(2025, 3, 1), 'UTC')).toHaveLength(1);
  });

  it('does not throw for events that cannot be expanded', () => {
    const broken: IcsCalendar = {
      name: null,
      warnings: [],
      events: [
        {
          uid: 'b',
          title: 'Broken',
          location: null,
          start: '2025-01-01T09:00',
          end: '2025-01-01T10:00',
          all_day: false,
          tz: null,
          rrule: null,
          exdates: [],
          recurrence_id: null,
          cancelled: false,
          busy: true,
        },
      ],
    };
    expect(icsOccurrences(broken, 0, Date.UTC(2030, 0, 1), 'UTC')).toEqual([]);
  });

  it('expands Outlook and Apple fixtures', () => {
    const outlook = icsOccurrences(
      parseIcs(OUTLOOK),
      Date.UTC(2025, 4, 1),
      Date.UTC(2025, 5, 1),
      'UTC',
    );
    expect(outlook.map((o) => o.title)).toEqual([
      'Planning',
      'Berlin sync',
      'Planning',
      'Planning',
    ]);
    expect(outlook[0]?.start).toBe(Date.UTC(2025, 4, 5, 17, 0)); // 10:00 PDT
    const apple = icsOccurrences(
      parseIcs(APPLE),
      Date.UTC(2025, 5, 1),
      Date.UTC(2025, 5, 2),
      'UTC',
    );
    expect(apple).toHaveLength(1);
    expect(apple[0]?.busy).toBe(false);
  });

  it('applies EXDATEs for all-day recurring events', () => {
    const c = parseIcs(
      vevent(
        'UID:a\nDTSTART;VALUE=DATE:20250301\nRRULE:FREQ=DAILY;COUNT=4\nEXDATE;VALUE=DATE:20250302',
      ),
    );
    const occ = icsOccurrences(c, Date.UTC(2025, 2, 1) - 864e5, Date.UTC(2025, 2, 10), 'UTC');
    expect(occ.map((o) => o.localStart)).toEqual(['2025-03-01', '2025-03-03', '2025-03-04']);
  });

  it('stops a feed full of costly rules at its time budget (review 0004, condition B)', () => {
    // Each is a COUNT series whose steps never meet its filter, so finding
    // where it ends spends that event's whole budget.
    const many = Array.from(
      { length: 60 },
      (_, i) =>
        `UID:x${i}\nDTSTART:${1100 + i}0106T090000Z\nDTEND:${1100 + i}0106T100000Z\nRRULE:FREQ=DAILY;INTERVAL=7;BYDAY=TU;COUNT=5`,
    );
    const c = parseIcs(wrap(many.map((b) => `BEGIN:VEVENT\n${b}\nEND:VEVENT`).join('\n')));
    expect(c.events).toHaveLength(60);
    const t = performance.now();
    icsOccurrences(c, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1), 'UTC', { budgetMs: 200 });
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
