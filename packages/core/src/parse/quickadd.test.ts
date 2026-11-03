// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseQuickAdd, type QuickAddContext, type QuickAddResult } from './quickadd';

type Expected = Partial<{
  title: string;
  date: string;
  time: string;
  endTime: string;
  allDay: boolean;
  place: string;
  private: boolean;
  ask: boolean;
}>;

const TUE: QuickAddContext = { today: '2026-11-03' };
const SUN: QuickAddContext = { today: '2026-11-08' };
const NYE: QuickAddContext = { today: '2026-12-31' };
const LEAP: QuickAddContext = { today: '2028-02-28' };

function expand(e: Expected): Omit<QuickAddResult, 'tokens'> {
  return {
    title: e.title ?? '',
    date: e.date ?? null,
    time: e.time ?? null,
    endTime: e.endTime ?? null,
    allDay: e.allDay ?? false,
    place: e.place ?? null,
    private: e.private ?? false,
    ask: e.ask ?? false,
  };
}

function check(input: string, ctx: QuickAddContext, e: Expected) {
  const { tokens: _tokens, ...rest } = parseQuickAdd(input, ctx);
  expect(rest).toEqual(expand(e));
}

const cases: [string, QuickAddContext, Expected][] = [
  // plain / relative
  ['buy milk', TUE, { title: 'buy milk' }],
  ['', TUE, {}],
  ['   ', TUE, {}],
  ['dentist today', TUE, { title: 'dentist', date: '2026-11-03', allDay: true }],
  ['Dentist TODAY', TUE, { title: 'Dentist', date: '2026-11-03', allDay: true }],
  ['dinner tonight', TUE, { title: 'dinner', date: '2026-11-03', time: '19:00' }],
  ['dinner tonight 8pm', TUE, { title: 'dinner', date: '2026-11-03', time: '20:00' }],
  ['groceries tomorrow', TUE, { title: 'groceries', date: '2026-11-04', allDay: true }],
  ['groceries tmrw', TUE, { title: 'groceries', date: '2026-11-04', allDay: true }],
  ['groceries tmr', TUE, { title: 'groceries', date: '2026-11-04', allDay: true }],
  ['brunch day after tomorrow', TUE, { title: 'brunch', date: '2026-11-05', allDay: true }],
  ['tomorrow 9am gym', TUE, { title: 'gym', date: '2026-11-04', time: '09:00' }],
  ['tomorrow tomorrow', TUE, { title: 'tomorrow', date: '2026-11-04', allDay: true }],
  // weekdays
  ['lunch monday', TUE, { title: 'lunch', date: '2026-11-09', allDay: true }],
  ['lunch mon', TUE, { title: 'lunch', date: '2026-11-09', allDay: true }],
  ['lunch tue', TUE, { title: 'lunch', date: '2026-11-03', allDay: true }],
  ['lunch tues', TUE, { title: 'lunch', date: '2026-11-03', allDay: true }],
  ['lunch wed', TUE, { title: 'lunch', date: '2026-11-04', allDay: true }],
  ['lunch thu', TUE, { title: 'lunch', date: '2026-11-05', allDay: true }],
  ['lunch thur', TUE, { title: 'lunch', date: '2026-11-05', allDay: true }],
  ['lunch thurs', TUE, { title: 'lunch', date: '2026-11-05', allDay: true }],
  ['lunch Thursday', TUE, { title: 'lunch', date: '2026-11-05', allDay: true }],
  ['lunch FRI', TUE, { title: 'lunch', date: '2026-11-06', allDay: true }],
  ['lunch sat', TUE, { title: 'lunch', date: '2026-11-07', allDay: true }],
  ['lunch saturday', TUE, { title: 'lunch', date: '2026-11-07', allDay: true }],
  ['lunch sun', TUE, { title: 'lunch', date: '2026-11-08', allDay: true }],
  ['lunch on friday', TUE, { title: 'lunch', date: '2026-11-06', allDay: true }],
  ['lunch this friday', TUE, { title: 'lunch', date: '2026-11-06', allDay: true }],
  ['lunch this tuesday', TUE, { title: 'lunch', date: '2026-11-03', allDay: true }],
  // `next X` = first X strictly after today (prototype behaviour).
  ['lunch next friday', TUE, { title: 'lunch', date: '2026-11-06', allDay: true }],
  ['lunch next monday', TUE, { title: 'lunch', date: '2026-11-09', allDay: true }],
  ['lunch next tuesday', TUE, { title: 'lunch', date: '2026-11-10', allDay: true }],
  ['lunch next sunday', TUE, { title: 'lunch', date: '2026-11-08', allDay: true }],
  ['lunch sunday', SUN, { title: 'lunch', date: '2026-11-08', allDay: true }],
  ['lunch next sunday', SUN, { title: 'lunch', date: '2026-11-15', allDay: true }],
  ['lunch next monday', SUN, { title: 'lunch', date: '2026-11-09', allDay: true }],
  ['lunch next sat', SUN, { title: 'lunch', date: '2026-11-14', allDay: true }],
  [
    'lunch next monday',
    { today: '2026-11-08', weekStart: 0 },
    { title: 'lunch', date: '2026-11-09', allDay: true },
  ],
  ['fri nov 20 party', TUE, { title: 'party', date: '2026-11-20', allDay: true }],
  // month + day
  ['trip nov 14', TUE, { title: 'trip', date: '2026-11-14', allDay: true }],
  ['trip november 14', TUE, { title: 'trip', date: '2026-11-14', allDay: true }],
  ['trip 14 nov', TUE, { title: 'trip', date: '2026-11-14', allDay: true }],
  ['trip 14th november', TUE, { title: 'trip', date: '2026-11-14', allDay: true }],
  ['trip Nov 14th', TUE, { title: 'trip', date: '2026-11-14', allDay: true }],
  ['trip on the 14th of nov', TUE, { title: 'trip', date: '2026-11-14', allDay: true }],
  ['trip dec 1st', TUE, { title: 'trip', date: '2026-12-01', allDay: true }],
  ['trip dec 2nd', TUE, { title: 'trip', date: '2026-12-02', allDay: true }],
  ['trip dec 3rd', TUE, { title: 'trip', date: '2026-12-03', allDay: true }],
  ['trip sept 9', TUE, { title: 'trip', date: '2027-09-09', allDay: true }],
  ['trip nov. 14', TUE, { title: 'trip', date: '2026-11-14', allDay: true }],
  ['trip nov 14 2027', TUE, { title: 'trip', date: '2027-11-14', allDay: true }],
  ['trip nov 14, 2027', TUE, { title: 'trip', date: '2027-11-14', allDay: true }],
  ['trip 14 nov 2027', TUE, { title: 'trip', date: '2027-11-14', allDay: true }],
  ['trip nov 3', TUE, { title: 'trip', date: '2026-11-03', allDay: true }],
  ['trip nov 2', TUE, { title: 'trip', date: '2027-11-02', allDay: true }],
  ['trip jan 5', NYE, { title: 'trip', date: '2027-01-05', allDay: true }],
  ['trip dec 31', NYE, { title: 'trip', date: '2026-12-31', allDay: true }],
  ['trip tomorrow', NYE, { title: 'trip', date: '2027-01-01', allDay: true }],
  ['trip feb 29', LEAP, { title: 'trip', date: '2028-02-29', allDay: true }],
  ['trip tomorrow', LEAP, { title: 'trip', date: '2028-02-29', allDay: true }],
  ['trip day after tomorrow', LEAP, { title: 'trip', date: '2028-03-01', allDay: true }],
  ['trip feb 29', TUE, { title: 'trip', date: '2028-02-29', allDay: true }],
  ['trip feb 29 2027', TUE, { title: 'trip feb 29 2027' }],
  ['trip feb 30', TUE, { title: 'trip feb 30' }],
  ['trip apr 31', TUE, { title: 'trip apr 31' }],
  ['trip 2026-11-14', TUE, { title: 'trip', date: '2026-11-14', allDay: true }],
  ['trip 2026-02-30', TUE, { title: 'trip 2026-02-30' }],
  ['trip 11/14', TUE, { title: 'trip 11/14' }],
  ['trip nov 14 and dec 5', TUE, { title: 'trip and dec 5', date: '2026-11-14', allDay: true }],
  // times
  ['2pm', TUE, { time: '14:00' }],
  ['call 7pm', TUE, { title: 'call', time: '19:00' }],
  ['call 7 pm', TUE, { title: 'call', time: '19:00' }],
  ['call 7:30pm', TUE, { title: 'call', time: '19:30' }],
  ['call 7.30pm', TUE, { title: 'call', time: '19:30' }],
  ['call 7:30 p.m.', TUE, { title: 'call', time: '19:30' }],
  ['call 7:30 P.M.', TUE, { title: 'call', time: '19:30' }],
  ['call 12am', TUE, { title: 'call', time: '00:00' }],
  ['call 12pm', TUE, { title: 'call', time: '12:00' }],
  ['call 11:45am', TUE, { title: 'call', time: '11:45' }],
  ['call 19:00', TUE, { title: 'call', time: '19:00' }],
  ['call 7:05', TUE, { title: 'call', time: '07:05' }],
  ['call 13pm', TUE, { title: 'call 13pm' }],
  ['call 7:75pm', TUE, { title: 'call 7:75pm' }],
  ['call 25:00', TUE, { title: 'call 25:00' }],
  ['call mom at 5', TUE, { title: 'call mom', time: '17:00' }],
  ['call at 7', TUE, { title: 'call', time: '19:00' }],
  ['call at 8', TUE, { title: 'call', time: '08:00' }],
  ['call at 11', TUE, { title: 'call', time: '11:00' }],
  ['call at 12', TUE, { title: 'call', time: '12:00' }],
  ['call at 1', TUE, { title: 'call', time: '13:00' }],
  ['call at 7:30', TUE, { title: 'call', time: '19:30' }],
  ['call at 19', TUE, { title: 'call', time: '19:00' }],
  ['call at 0', TUE, { title: 'call', time: '00:00' }],
  ['call at 99', TUE, { title: 'call at 99' }],
  ['call at 5pm', TUE, { title: 'call', time: '17:00' }],
  ['lunch noon', TUE, { title: 'lunch', time: '12:00' }],
  ['lunch at noon', TUE, { title: 'lunch', time: '12:00' }],
  ['party midnight', TUE, { title: 'party', time: '00:00' }],
  ['run morning', TUE, { title: 'run', time: '09:00' }],
  ['run tomorrow afternoon', TUE, { title: 'run', date: '2026-11-04', time: '15:00' }],
  ['drinks friday evening', TUE, { title: 'drinks', date: '2026-11-06', time: '18:00' }],
  ['run morning 6am', TUE, { title: 'run morning', time: '06:00' }],
  ['dinner tomorrow at 7pm', TUE, { title: 'dinner', date: '2026-11-04', time: '19:00' }],
  ['dinner at 7pm tomorrow', TUE, { title: 'dinner', date: '2026-11-04', time: '19:00' }],
  ['dinner 7pm then 9pm movie', TUE, { title: 'dinner then 9pm movie', time: '19:00' }],
  ['nov 14 7pm', TUE, { date: '2026-11-14', time: '19:00' }],
  ['nov 14 - 7pm', TUE, { date: '2026-11-14', time: '19:00' }],
  ['the 1975 concert', TUE, { title: 'the 1975 concert' }],
  ['room 5-6 people', TUE, { title: 'room 5-6 people' }],
  ['7.30 is the price', TUE, { title: '7.30 is the price' }],
  ['take 7 amazing pills', TUE, { title: 'take 7 amazing pills' }],
  // ranges
  ['jam 7-9pm', TUE, { title: 'jam', time: '19:00', endTime: '21:00' }],
  ['jam 7pm-9pm', TUE, { title: 'jam', time: '19:00', endTime: '21:00' }],
  ['jam 7 to 9pm', TUE, { title: 'jam', time: '19:00', endTime: '21:00' }],
  ['jam from 7 to 9pm', TUE, { title: 'jam', time: '19:00', endTime: '21:00' }],
  ['jam from 7 to 9', TUE, { title: 'jam', time: '19:00', endTime: '21:00' }],
  ['jam from 11 to 1', TUE, { title: 'jam', time: '11:00', endTime: '13:00' }],
  ['jam 7:30-8:45pm', TUE, { title: 'jam', time: '19:30', endTime: '20:45' }],
  ['jam 19:00-21:00', TUE, { title: 'jam', time: '19:00', endTime: '21:00' }],
  ['jam 10am-2pm', TUE, { title: 'jam', time: '10:00', endTime: '14:00' }],
  ['jam 11-1pm', TUE, { title: 'jam', time: '11:00', endTime: '13:00' }],
  ['jam 10-2pm', TUE, { title: 'jam', time: '10:00', endTime: '14:00' }],
  ['jam 12-1pm', TUE, { title: 'jam', time: '12:00', endTime: '13:00' }],
  ['jam 7pm-9', TUE, { title: 'jam', time: '19:00', endTime: '21:00' }],
  ['jam 7pm-21:00', TUE, { title: 'jam', time: '19:00', endTime: '21:00' }],
  ['jam 9-9pm', TUE, { title: 'jam', time: '09:00', endTime: '21:00' }],
  ['jam 7pm until 10pm', TUE, { title: 'jam', time: '19:00', endTime: '22:00' }],
  ['jam 7pm until 10', TUE, { title: 'jam', time: '19:00', endTime: '22:00' }],
  ['jam 9am until 11', TUE, { title: 'jam', time: '09:00', endTime: '11:00' }],
  ['jam 9am until 99', TUE, { title: 'jam until 99', time: '09:00' }],
  ['jam until 10pm', TUE, { title: 'jam', time: '22:00' }],
  ['jam friday 7-9pm', TUE, { title: 'jam', date: '2026-11-06', time: '19:00', endTime: '21:00' }],
  // place
  ["dinner @ Luigi's", TUE, { title: 'dinner', place: "Luigi's" }],
  ["dinner @Luigi's", TUE, { title: 'dinner', place: "Luigi's" }],
  [
    "dinner @ Luigi's friday 7pm",
    TUE,
    { title: 'dinner', place: "Luigi's", date: '2026-11-06', time: '19:00' },
  ],
  [
    "dinner friday 7pm @ Luigi's Pizza",
    TUE,
    { title: 'dinner', place: "Luigi's Pizza", date: '2026-11-06', time: '19:00' },
  ],
  ["dinner @ Luigi's at 7pm", TUE, { title: 'dinner', place: "Luigi's", time: '19:00' }],
  ["dinner at @ Luigi's", TUE, { title: 'dinner', place: "Luigi's" }],
  ["dinner @ Luigi's #private", TUE, { title: 'dinner', place: "Luigi's", private: true }],
  ["dinner @ Luigi's?", TUE, { title: 'dinner', place: "Luigi's", ask: true }],
  ['dinner @ Sunset Grill', TUE, { title: 'dinner', place: 'Sunset Grill' }],
  [
    "dinner @ Luigi's friday sat",
    TUE,
    { title: 'dinner sat', place: "Luigi's", date: '2026-11-06', allDay: true },
  ],
  ['dinner @', TUE, { title: 'dinner @' }],
  ['dinner @   ', TUE, { title: 'dinner @' }],
  ['mail me a@b.com', TUE, { title: 'mail me a@b.com' }],
  // privacy / ask
  ['gift ideas #private', TUE, { title: 'gift ideas', private: true }],
  ['gift #PRIVATE ideas', TUE, { title: 'gift ideas', private: true }],
  ['gift #privately', TUE, { title: 'gift #privately' }],
  ['privately buy gift', TUE, { title: 'privately buy gift' }],
  ['dinner friday?', TUE, { title: 'dinner', date: '2026-11-06', allDay: true, ask: true }],
  ['dinner friday ?? ', TUE, { title: 'dinner', date: '2026-11-06', allDay: true, ask: true }],
  ['what?', TUE, { title: 'what', ask: true }],
  ['why? because', TUE, { title: 'why? because' }],
  [
    'dinner fri 7pm #private?',
    TUE,
    { title: 'dinner', date: '2026-11-06', time: '19:00', private: true, ask: true },
  ],
  ['#private', TUE, { private: true }],
  // title cleanup
  ['at 7pm dinner', TUE, { title: 'dinner', time: '19:00' }],
  ['dinner on', TUE, { title: 'dinner' }],
  ['dinner, friday', TUE, { title: 'dinner', date: '2026-11-06', allDay: true }],
  ['on', TUE, { title: 'on' }],
  ['on friday', TUE, { date: '2026-11-06', allDay: true }],
  [
    '  lots   of   space   tomorrow  ',
    TUE,
    { title: 'lots of space', date: '2026-11-04', allDay: true },
  ],
  // negatives
  ['Mondayitis is real', TUE, { title: 'Mondayitis is real' }],
  ['sunset walk', TUE, { title: 'sunset walk' }],
  ['mayday', TUE, { title: 'mayday' }],
  ['march on washington', TUE, { title: 'march on washington' }],
  ['march', TUE, { title: 'march' }],
  ['march 5', TUE, { date: '2027-03-05', allDay: true }],
  ['may i have 5 minutes', TUE, { title: 'may i have 5 minutes' }],
  ['novel 5', TUE, { title: 'novel 5' }],
  ['feb 30', TUE, { title: 'feb 30' }],
  ['saturdays are fun', TUE, { title: 'saturdays are fun' }],
  ['todayish', TUE, { title: 'todayish' }],
];

describe('parseQuickAdd', () => {
  it.each(cases)('%j (%#)', (input, ctx, expected) => {
    check(input, ctx, expected);
  });

  it('has a substantial table', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  it('rejects an invalid ctx.today', () => {
    expect(() => parseQuickAdd('x', { today: 'nope' })).toThrow(RangeError);
    expect(() => parseQuickAdd('x', { today: '2026-02-30' })).toThrow(RangeError);
  });
});

describe('tokens', () => {
  const inputs = [
    "dinner @ Luigi's friday 7pm #private?",
    'jam from 7 to 9pm on nov 14th',
    'jam 7pm until 10pm tomorrow',
    'run tomorrow morning',
    'tonight   at   noon',
    'fri nov 20 party @ the bar',
    'ünï ☃ tomorrow 7pm',
    'nothing here',
  ];

  it.each(inputs)('offsets slice the original text and are sorted: %j', (input) => {
    const { tokens } = parseQuickAdd(input, TUE);
    let prevEnd = 0;
    for (const t of tokens) {
      expect(input.slice(t.start, t.end)).toBe(t.text);
      expect(t.start).toBeGreaterThanOrEqual(prevEnd);
      expect(t.end).toBeGreaterThan(t.start);
      prevEnd = t.end;
    }
  });

  it('reports token types', () => {
    const { tokens } = parseQuickAdd("dinner @ Luigi's friday 7pm #private?", TUE);
    expect(tokens.map((t) => [t.type, t.text])).toEqual([
      ['place', "@ Luigi's"],
      ['date', 'friday'],
      ['time', '7pm'],
      ['privacy', '#private'],
      ['ask', '?'],
    ]);
  });

  it('includes connectors in the token and the until clause', () => {
    const { tokens } = parseQuickAdd('jam on friday from 7 to 9pm until 10pm', TUE);
    expect(tokens.map((t) => t.text)).toEqual(['on friday', 'from 7 to 9pm']);
    const u = parseQuickAdd('jam 7pm until 10pm', TUE).tokens.map((t) => t.text);
    expect(u).toEqual(['7pm', 'until 10pm']);
  });
});

describe('robustness', () => {
  function rng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }
  const alphabet = [
    ...'abcxyz 0123456789:.-–@#?,/'.split(''),
    '😀',
    '☃',
    'é',
    'pm',
    'am',
    'at ',
    'nov ',
    'fri ',
    'to ',
    'until ',
    '\n',
    '\t',
  ];

  it('never throws on random input', () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(r() * 40);
      let s = '';
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(r() * alphabet.length)] ?? '';
      const out = parseQuickAdd(s, TUE);
      for (const t of out.tokens) expect(s.slice(t.start, t.end)).toBe(t.text);
    }
  });

  it('handles emoji and odd unicode', () => {
    expect(parseQuickAdd('🎉 party 👩‍❤️‍👨 tomorrow 7pm', TUE)).toMatchObject({
      title: '🎉 party 👩‍❤️‍👨',
      date: '2026-11-04',
      time: '19:00',
    });
  });

  it('handles ~5k chars of input quickly', () => {
    const inputs = [
      'a'.repeat(5000),
      'at 7 '.repeat(1000),
      '1 '.repeat(2500),
      `${'nov '.repeat(1250)}`,
      '@ '.repeat(2500),
      'dinner friday 7pm '.repeat(280),
      `${' '.repeat(5000)}x`,
    ];
    for (const input of inputs) {
      const t0 = performance.now();
      parseQuickAdd(input, TUE);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});
