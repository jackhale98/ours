// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { icsOccurrences, parseIcs } from './index';
import { type IcsExportEvent, writeIcs } from './write';

const base: IcsExportEvent = {
  uid: 'rec1',
  title: 'Dinner',
  start: '2025-03-03T19:00',
  end: '2025-03-03T20:30',
  allDay: false,
  tz: 'America/New_York',
  rrule: null,
  updatedAt: Date.UTC(2025, 0, 2, 3, 4, 5),
};

const lines = (s: string) => s.split('\r\n');
const octets = (s: string) => new TextEncoder().encode(s).length;
const unfold = (s: string) => s.replace(/\r\n /g, '');

describe('writeIcs', () => {
  it('writes the calendar envelope with CRLF endings', () => {
    const out = writeIcs([base], { name: 'Our, Plans' });
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const l = lines(out);
    expect(l.slice(0, 5)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Ours//Ours//EN',
      'CALSCALE:GREGORIAN',
      'X-WR-CALNAME:Our\\, Plans',
    ]);
    expect(writeIcs([], { name: 'x', prodId: '-//Me//EN' })).toContain('PRODID:-//Me//EN\r\n');
  });

  it('writes timed events with TZID and no VTIMEZONE', () => {
    const out = writeIcs([{ ...base, status: 'tentative' }], { name: 'n' });
    expect(out).toContain('UID:rec1@ours\r\n');
    expect(out).toContain('DTSTAMP:20250102T030405Z\r\n');
    expect(out).toContain('LAST-MODIFIED:20250102T030405Z\r\n');
    expect(out).toContain('DTSTART;TZID=America/New_York:20250303T190000\r\n');
    expect(out).toContain('DTEND;TZID=America/New_York:20250303T203000\r\n');
    expect(out).toContain('STATUS:TENTATIVE\r\n');
    expect(out).not.toContain('VTIMEZONE');
    expect(writeIcs([{ ...base, status: 'confirmed' }], { name: 'n' })).toContain(
      'STATUS:CONFIRMED',
    );
    expect(writeIcs([base], { name: 'n' })).not.toContain('STATUS');
  });

  it('writes all-day events as VALUE=DATE', () => {
    const out = writeIcs(
      [{ ...base, allDay: true, tz: null, start: '2025-12-24', end: '2025-12-26' }],
      { name: 'n' },
    );
    expect(out).toContain('DTSTART;VALUE=DATE:20251224\r\n');
    expect(out).toContain('DTEND;VALUE=DATE:20251226\r\n');
    expect(out).not.toContain('TZID');
  });

  it('escapes TEXT and strips control characters', () => {
    const out = writeIcs(
      [
        {
          ...base,
          title: 'a\\b;c,d\ne\r\nf\u0000g\u0007h',
          location: 'Room 1; Floor 2',
          description: 'line1\nline2',
        },
      ],
      { name: 'n' },
    );
    expect(out).toContain('SUMMARY:a\\\\b\\;c\\,d\\ne\\nfgh\r\n');
    expect(out).toContain('LOCATION:Room 1\\; Floor 2\r\n');
    expect(out).toContain('DESCRIPTION:line1\\nline2\r\n');
  });

  it('passes RRULE through, stripping CR/LF', () => {
    const out = writeIcs([{ ...base, rrule: 'FREQ=WEEKLY;BYDAY=MO\r\nX-INJECT:1' }], {
      name: 'n',
    });
    expect(out).toContain('RRULE:FREQ=WEEKLY;BYDAY=MOX-INJECT:1\r\n');
    expect(out).not.toMatch(/\r\nX-INJECT/);
  });

  it('skips malformed events without throwing', () => {
    const out = writeIcs(
      [
        { ...base, uid: 'a', start: 'nope' },
        { ...base, uid: 'b', end: '2025-02-30T10:00' },
        { ...base, uid: 'c', tz: 'Bad Zone;X' },
        { ...base, uid: 'd', tz: null },
        { ...base, uid: 'e', allDay: true, tz: null, start: '2025-01-01T10:00', end: '2025-01-02' },
        { ...base, uid: 'ok' },
      ],
      { name: 'n' },
    );
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(out).toContain('UID:ok@ours');
  });

  describe('folding', () => {
    const check = (title: string) => {
      const out = writeIcs([{ ...base, title }], { name: 'n' });
      const l = lines(out);
      for (const line of l) expect(octets(line)).toBeLessThanOrEqual(75);
      const sum = l.filter((x) => x.startsWith(' ') || x.startsWith('SUMMARY'));
      expect(sum.length).toBeGreaterThan(1);
      // Every folded chunk must be valid UTF-8 on its own (no split characters).
      for (const line of l)
        expect(
          new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(line)),
        ).toBe(line);
      expect(unfold(out)).toContain(`SUMMARY:${title}\r\n`);
      return out;
    };

    it('folds long ASCII lines at 75 octets', () => {
      const out = check('x'.repeat(200));
      expect(lines(out).find((x) => x.startsWith('SUMMARY'))).toHaveLength(75);
    });

    it('never splits multi-byte characters', () => {
      check('é'.repeat(100));
      check('😀'.repeat(60));
      check(`${'a'.repeat(70)}😀日本語éa`.repeat(4));
    });
  });

  describe('round trip', () => {
    it('parses back to the same titles, times, locations and rrule', () => {
      const events: IcsExportEvent[] = [
        {
          ...base,
          title: 'Dinner; with, "friends" \\o/ 😀 café',
          location: "Luigi's, 5th Ave; NYC",
          description: 'Bring wine\nand cheese',
          rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
          status: 'confirmed',
        },
        {
          ...base,
          uid: 'trip',
          title: 'Trip',
          allDay: true,
          tz: null,
          start: '2025-06-10',
          end: '2025-06-13',
        },
        {
          ...base,
          uid: 'long',
          title: 'Ünïcödé '.repeat(20).trim(),
          start: '2025-07-01T09:15',
          end: '2025-07-01T10:00',
          tz: 'Europe/Paris',
        },
      ];
      const cal = parseIcs(writeIcs(events, { name: 'Our Plans, 2025' }));
      expect(cal.warnings).toEqual([]);
      expect(cal.name).toBe('Our Plans, 2025');
      expect(cal.events).toHaveLength(3);

      const [dinner, trip, long] = cal.events;
      expect(dinner).toMatchObject({
        uid: 'rec1@ours',
        title: events[0]?.title,
        location: "Luigi's, 5th Ave; NYC",
        start: '2025-03-03T19:00',
        end: '2025-03-03T20:30',
        all_day: false,
        tz: 'America/New_York',
        rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
        cancelled: false,
      });
      expect(trip).toMatchObject({
        title: 'Trip',
        start: '2025-06-10',
        end: '2025-06-13',
        all_day: true,
        tz: null,
        rrule: null,
      });
      expect(long).toMatchObject({
        title: events[2]?.title,
        start: '2025-07-01T09:15',
        tz: 'Europe/Paris',
      });

      const occ = icsOccurrences(cal, Date.UTC(2025, 2, 1), Date.UTC(2025, 3, 30), 'UTC');
      expect(occ.filter((o) => o.uid === 'rec1@ours')).toHaveLength(4);
    });
  });
});
