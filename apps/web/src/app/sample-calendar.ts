// SPDX-License-Identifier: AGPL-3.0-or-later
/** A realistic sample work calendar (.ics text) relative to today, for the demo. */
import { addDays, dateIn } from '@ours/core/time';
import { dow } from './select';

const compact = (date: string) => date.replaceAll('-', '');

export function sampleWorkIcs(today: string, tz: string): string {
  const d = (n: number) => compact(addDays(today, n));
  // Next weekday at or after today + n.
  const weekday = (n: number) => {
    let x = n;
    while (dow(addDays(today, x)) === 0 || dow(addDays(today, x)) === 6) x++;
    return x;
  };
  const late = weekday(1);
  const review = weekday(3);
  const skip = weekday(2);
  const stamp = `${compact(dateIn(Date.now(), 'UTC'))}T000000Z`;
  const ev = (lines: string[]) => ['BEGIN:VEVENT', `DTSTAMP:${stamp}`, ...lines, 'END:VEVENT'];
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ours//Sample work calendar//EN',
    'X-WR-CALNAME:Work',
    `X-WR-TIMEZONE:${tz}`,
    ...ev([
      'UID:standup@sample.ours',
      'SUMMARY:Team standup',
      `DTSTART;TZID=${tz}:${d(0)}T093000`,
      `DTEND;TZID=${tz}:${d(0)}T094500`,
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      `EXDATE;TZID=${tz}:${d(skip)}T093000`,
    ]),
    ...ev([
      'UID:focus@sample.ours',
      'SUMMARY:Focus time',
      `DTSTART;TZID=${tz}:${d(0)}T130000`,
      `DTEND;TZID=${tz}:${d(0)}T150000`,
      'RRULE:FREQ=WEEKLY;BYDAY=TU,TH',
      'TRANSP:TRANSPARENT',
    ]),
    ...ev([
      'UID:launch@sample.ours',
      'SUMMARY:Launch prep (runs late)',
      'LOCATION:Office\\, 4th floor',
      `DTSTART;TZID=${tz}:${d(late)}T170000`,
      `DTEND;TZID=${tz}:${d(late)}T193000`,
    ]),
    ...ev([
      'UID:review@sample.ours',
      'SUMMARY:Quarterly review',
      `DTSTART;TZID=${tz}:${d(review)}T140000`,
      `DTEND;TZID=${tz}:${d(review)}T160000`,
    ]),
    ...ev([
      'UID:offsite@sample.ours',
      'SUMMARY:Team offsite',
      `DTSTART;VALUE=DATE:${d(12)}`,
      `DTEND;VALUE=DATE:${d(13)}`,
    ]),
    ...ev([
      'UID:cancelled@sample.ours',
      'SUMMARY:Cancelled sync',
      'STATUS:CANCELLED',
      `DTSTART;TZID=${tz}:${d(1)}T110000`,
      `DTEND;TZID=${tz}:${d(1)}T113000`,
    ]),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
