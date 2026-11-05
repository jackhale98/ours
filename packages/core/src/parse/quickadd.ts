// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Natural-language quick-add parser. Pure, dependency-free, never throws on input text.
 *
 * Documented rules:
 * - Only the FIRST date and FIRST time/range are used; later ones stay in the title.
 * - `fri` / `this fri` = next occurrence on or after today (today counts).
 *   `next fri` = the first Friday strictly after today, as in docs/prototype.html: on Tue 3 Nov
 *   `next fri` = 6 Nov; on a Friday it is the following Friday. ("Next Friday" is ambiguous
 *   in speech; the live chips under the input show the resolved date, and it is editable.)
 * - Month/day without a year that is already past rolls to next year (today itself does not).
 *   `feb 29` finds the next leap year. Invalid days (`feb 30`) are not dates.
 * - Numeric dates `11/14` (and `11/14/2027`) are read in the locale's order: month first
 *   (`ctx.dateOrder` 'MD', the default) or day first ('DM'). ISO `2026-11-14` always works.
 * - Bare hour after `at`/`from` (no am/pm): 8-11 -> am, 12 -> noon, 1-7 -> pm. Hours > 12 are 24h.
 *   A bare `H:mm` without `at` follows the same rule (`2:30` -> 14:30), unless it is written the
 *   24-hour way: a leading zero (`07:30`) or an hour over 12 (`19:00`). Bare `7` or `7.30` is
 *   not a time (it could be a number: "buy 8 eggs").
 * - Date ranges become several days: `sat-sun`, `fri to mon`, `dec 3-10`, `3-10 dec`.
 * - `for 2 hours`, `for 90 mins`, `for an hour`, `for half an hour` set the end after a time.
 * - `in 3 days`, `in 2 weeks`, `next week` (the start of next week, Monday unless
 *   `ctx.weekStart` says otherwise) are dates.
 * - Monthly on a day: `on the 1st every month`, `every month on the 15th`, `monthly on the 3rd`.
 * - Range meridiem: `11-1pm` -> 11:00-13:00 (start borrows the end's am/pm if that keeps
 *   start < end, otherwise the opposite one).
 * - `morning`/`afternoon`/`evening` (09:00/15:00/18:00) apply only when there is no explicit time.
 * - `tonight` sets time 19:00 when no explicit time was given.
 * - Place: text after a `@` (at start or after whitespace) up to the next recognised
 *   date/time/#private/trailing-? token, or end of input.
 * - `ctx.nowTime` and `ctx.weekStart` are reserved; dates never roll by time.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface QuickAddContext {
  today: string;
  nowTime?: string;
  weekStart?: Weekday;
  /** How numeric dates read: month first (US) or day first. Default 'MD'. */
  dateOrder?: 'MD' | 'DM';
}

export type TokenType = 'date' | 'time' | 'place' | 'privacy' | 'ask' | 'repeat';

export interface ParsedToken {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

export interface QuickAddResult {
  title: string;
  date: string | null;
  /** The last day, for a range like `sat-sun` or `dec 3-10`; null otherwise. */
  endDate: string | null;
  time: string | null;
  endTime: string | null;
  allDay: boolean;
  place: string | null;
  private: boolean;
  ask: boolean;
  /** RRULE value for "every …" phrases, e.g. FREQ=WEEKLY;BYDAY=SA; null if it doesn't repeat. */
  rrule: string | null;
  tokens: ParsedToken[];
}

interface Cand<T> {
  start: number;
  end: number;
  value: T;
}

type Ap = 'a' | 'p' | '';
interface Part {
  h: number;
  min: number;
  sep: string;
  ap: Ap;
}
interface TimeVal {
  start: number;
  end: number | null;
}
interface DateVal {
  date: string;
  tonight: boolean;
  /** Last day of a range. */
  end?: string;
}

const WD =
  'sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?';
const MON =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WD_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MON_KEYS = MON.split('|').map((m) => m.slice(0, 3));
const LEAD = `(?:on\\s+)?(?:(?:${WD})\\.?,?\\s+)?`;
const AP = '[ap](?:m|\\.m\\.)';
const hm = (n: number) =>
  `(?<h${n}>\\d{1,2})(?:(?<s${n}>[:.])(?<m${n}>\\d{2}))?(?:\\s*(?<a${n}>${AP}))?`;
const TIME_END = '(?![\\w]|[:.]\\d)';

const RE_REL = /(?<!\w)(?<w>day\s+after\s+tomorrow|today|tonight|tomorrow|tmrw|tmr)(?!\w)/gi;
const RE_WD = new RegExp(`(?<!\\w)(?:(?<q>on|this|next)\\s+)?(?<w>${WD})(?!\\w)`, 'gi');
const RE_MD_A = new RegExp(
  `(?<!\\w)${LEAD}(?<mo>${MON})\\.?\\s+(?<d>\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?![\\w:])(?:,?\\s+(?<y>\\d{4})(?!\\d))?`,
  'gi',
);
const RE_MD_B = new RegExp(
  `(?<![\\w:.\\-])${LEAD}(?:the\\s+)?(?<d>\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?<mo>${MON})(?!\\w)(?:,?\\s+(?<y>\\d{4})(?!\\d))?`,
  'gi',
);
const RE_ISO = /(?<![\w-])(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})(?![\w-])/g;
const RE_NUM = /(?<![\w/.:-])(?<a>\d{1,2})\/(?<b>\d{1,2})(?:\/(?<y>\d{2}|\d{4}))?(?![\w/])/g;
const TO = '\\s*(?:-|–|to|through|thru|until|till)\\s*';
const RE_WD_RANGE = new RegExp(`(?<!\\w)(?:from\\s+)?(?<a>${WD})${TO}(?<b>${WD})(?!\\w)`, 'gi');
const RE_MD_RANGE = new RegExp(
  `(?<!\\w)(?:from\\s+)?(?<mo>${MON})\\.?\\s+(?<d1>\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to)\\s*(?:(?<mo2>${MON})\\.?\\s+)?(?<d2>\\d{1,2})(?:st|nd|rd|th)?(?![\\w:])`,
  'gi',
);
const RE_DM_RANGE = new RegExp(
  `(?<![\\w:.-])(?<d1>\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–)\\s*(?<d2>\\d{1,2})(?:st|nd|rd|th)?\\s+(?<mo>${MON})(?!\\w)`,
  'gi',
);
const RE_IN =
  /(?<!\w)in\s+(?<n>\d{1,3}|a|an|one|two|three|four|five|six|seven)\s+(?<u>days?|weeks?)(?!\w)/gi;
const RE_NEXT_WEEK = /(?<!\w)next\s+week(?!\w)/gi;
const RE_FOR =
  /(?<!\w)for\s+(?:(?<half>half\s+an?)\s+hour|(?<n>\d{1,3}(?:\.\d)?|an?|one|two|three|four|five|six)\s*(?<u>hours?|hrs?|h|minutes?|mins?|m))(?!\w)/gi;
const NUM_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};
const RE_TIME = new RegExp(
  `(?<![\\w:.\\-])(?<pre>(?:from|at)\\s+)?${hm(1)}(?:\\s*(?:-|–|to)\\s*${hm(2)})?${TIME_END}`,
  'gi',
);
const RE_UNTIL = new RegExp(`(?<!\\w)(?:until|till)\\s+${hm(1)}${TIME_END}`, 'gi');
const RE_WORD_TIME = /(?<!\w)(?:(?:from|at)\s+)?(?<w>noon|midnight)(?!\w)/gi;
const RE_DAYPART = /(?<!\w)(?<w>morning|afternoon|evening)(?!\w)/gi;
const RE_PRIVATE = /(?<!\w)#private(?!\w)/i;
const RE_ASK = /(\?+)\s*$/;
const RE_AT = /(?:^|\s)@/;
const EDGE_WORDS = new Set(['at', 'on', 'from', 'until', 'till']);
const EDGE_PUNCT = /^[\s,;:\-–]+|[\s,;:\-–]+$/g;

// ---- calendar math on integer Y/M/D (UTC day numbers) ----

const pad = (n: number) => String(n).padStart(2, '0');
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) =>
  m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
const toDays = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86_400_000;
const fromDays = (n: number) => {
  const dt = new Date(n * 86_400_000);
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};
const dowOf = (n: number) => (((n % 7) + 11) % 7) as Weekday; // day 0 (1970-01-01) is a Thursday
const validYmd = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const fmtMin = (t: number) => `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;

function parseToday(s: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const [y, mo, d] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
  if (!m || !validYmd(y, mo, d)) throw new RangeError(`Invalid ctx.today: ${s}`);
  return { y, m: mo, d };
}

// ---- helpers ----

function scan<T>(re: RegExp, text: string, build: (m: RegExpExecArray) => T | null): Cand<T>[] {
  const out: Cand<T>[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const value = build(m);
    if (value === null) re.lastIndex = m.index + 1;
    else out.push({ start: m.index, end: m.index + m[0].length, value });
  }
  return out;
}

const first = <T>(c: Cand<T>[]): Cand<T> | undefined =>
  [...c].sort((a, b) => a.start - b.start || b.end - a.end)[0];

const grp = (m: RegExpExecArray, k: string): string | undefined => m.groups?.[k];

function getPart(m: RegExpExecArray, n: number): Part | undefined {
  const h = grp(m, `h${n}`);
  if (h === undefined) return undefined;
  const ap = grp(m, `a${n}`)?.[0]?.toLowerCase() ?? '';
  return {
    h: Number(h),
    min: Number(grp(m, `m${n}`) ?? 0),
    sep: grp(m, `s${n}`) ?? '',
    ap: ap === 'a' || ap === 'p' ? ap : '',
  };
}

const flip = (ap: Ap): Ap => (ap === 'a' ? 'p' : 'a');

function minutes(p: Part, ap: Ap, bare: boolean): number | null {
  if (p.min > 59) return null;
  if (ap) {
    if (p.h < 1 || p.h > 12) return null;
    return ((p.h % 12) + (ap === 'p' ? 12 : 0)) * 60 + p.min;
  }
  if (p.h > 23) return null;
  const h = bare && p.h >= 1 && p.h <= 7 ? p.h + 12 : p.h;
  return h * 60 + p.min;
}

function buildTime(m: RegExpExecArray): TimeVal | null {
  const p1 = getPart(m, 1);
  if (!p1) return null;
  const p2 = getPart(m, 2);
  // `H:mm` without am/pm reads like "at H:mm" unless written the 24-hour way
  // (`07:30`, `19:00`): "Haircut 2:30" is in the afternoon (review 0009, P-9).
  const h1 = grp(m, 'h1') ?? '';
  const clock = p1.sep === ':' && !p1.ap && !(h1.length === 2 && h1.startsWith('0'));
  const bare = grp(m, 'pre') !== undefined || clock;
  if (!p1.ap && !p2?.ap && grp(m, 'pre') === undefined && p1.sep !== ':') return null;
  const opts = (own: Ap, other: Ap): Ap[] =>
    own ? [own] : other ? [other, flip(other), ''] : [''];
  const starts = opts(p1.ap, p2?.ap ?? '');
  const ends: Ap[] = p2 ? opts(p2.ap, p1.ap) : [''];
  let fallback: TimeVal | null = null;
  for (const s of starts) {
    for (const e of ends) {
      const sv = minutes(p1, s, bare);
      const ev = p2 ? minutes(p2, e, bare) : null;
      if (sv === null || (p2 && ev === null)) continue;
      const val = { start: sv, end: ev };
      if (ev === null || sv < ev) return val;
      fallback ??= val;
    }
  }
  if (fallback?.end != null && fallback.end <= fallback.start && !p2?.ap && fallback.end < 720) {
    fallback.end += 720; // bare range like `from 7 to 9`: end is the same half-day
  }
  return fallback;
}

function buildDate(m: RegExpExecArray, t: { y: number; m: number; d: number }): string | null {
  const mo = MON_KEYS.indexOf((grp(m, 'mo') ?? '').slice(0, 3).toLowerCase()) + 1;
  const d = Number(grp(m, 'd'));
  const year = grp(m, 'y');
  if (year !== undefined) {
    return validYmd(Number(year), mo, d) ? `${year}-${pad(mo)}-${pad(d)}` : null;
  }
  const todayN = toDays(t.y, t.m, t.d);
  for (let y = t.y; y <= t.y + 8; y++) {
    if (validYmd(y, mo, d) && toDays(y, mo, d) >= todayN) return `${pad(y)}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

function findDates(
  text: string,
  t: { y: number; m: number; d: number },
  order: 'MD' | 'DM' = 'MD',
  weekStart?: Weekday,
) {
  const todayN = toDays(t.y, t.m, t.d);
  const out: Cand<DateVal>[] = [];
  const add = (c: Cand<string>[]) => {
    for (const x of c) out.push({ ...x, value: { date: x.value, tonight: false } });
  };
  out.push(
    ...scan(RE_REL, text, (m) => {
      const w = (grp(m, 'w') ?? '').toLowerCase();
      const plus = w.startsWith('day') ? 2 : w.startsWith('tom') || w.startsWith('tm') ? 1 : 0;
      return { date: fromDays(todayN + plus), tonight: w === 'tonight' };
    }),
  );
  add(
    scan(RE_WD, text, (m) => {
      const target = WD_KEYS.indexOf((grp(m, 'w') ?? '').slice(0, 3).toLowerCase());
      const delta = (target - dowOf(todayN) + 7) % 7;
      const plus = grp(m, 'q')?.toLowerCase() === 'next' && delta === 0 ? 7 : 0;
      return fromDays(todayN + delta + plus);
    }),
  );
  add(scan(RE_MD_A, text, (m) => buildDate(m, t)));
  add(scan(RE_MD_B, text, (m) => buildDate(m, t)));
  add(
    scan(RE_ISO, text, (m) => {
      const [y, mo, d] = [Number(grp(m, 'y')), Number(grp(m, 'mo')), Number(grp(m, 'd'))];
      return validYmd(y, mo, d) ? `${grp(m, 'y')}-${pad(mo)}-${pad(d)}` : null;
    }),
  );
  // 11/14 or 14/11, by the locale's order; a past date without a year is next year's.
  add(
    scan(RE_NUM, text, (m) => {
      const [a, b] = [Number(grp(m, 'a')), Number(grp(m, 'b'))];
      const [mo, d] = order === 'DM' ? [b, a] : [a, b];
      const yy = grp(m, 'y');
      if (yy !== undefined) {
        const y = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
        return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
      }
      return nextYmd(mo, d, t);
    }),
  );
  // "in 3 days", "in 2 weeks", "next week"
  add(
    scan(RE_IN, text, (m) => {
      const raw = (grp(m, 'n') ?? '').toLowerCase();
      const n = NUM_WORDS[raw] ?? Number(raw);
      if (!Number.isFinite(n) || n < 1) return null;
      return fromDays(todayN + n * ((grp(m, 'u') ?? '').startsWith('w') ? 7 : 1));
    }),
  );
  add(
    scan(RE_NEXT_WEEK, text, () => {
      const start = weekStart ?? 1;
      const delta = (start - dowOf(todayN) + 7) % 7 || 7;
      return fromDays(todayN + delta);
    }),
  );
  // Ranges: "sat-sun", "fri to mon", "dec 3-10", "3-10 dec"
  out.push(
    ...scan(RE_WD_RANGE, text, (m) => {
      const a = WD_KEYS.indexOf((grp(m, 'a') ?? '').slice(0, 3).toLowerCase());
      const b = WD_KEYS.indexOf((grp(m, 'b') ?? '').slice(0, 3).toLowerCase());
      if (a < 0 || b < 0) return null;
      const s = todayN + ((a - dowOf(todayN) + 7) % 7);
      const e = s + ((b - a + 7) % 7 || 7);
      return { date: fromDays(s), end: fromDays(e), tonight: false };
    }),
    ...scan(RE_MD_RANGE, text, (m) => monthRange(m, t)),
    ...scan(RE_DM_RANGE, text, (m) => monthRange(m, t)),
  );
  return out;
}

/** The next month/day on or after today (rolling to a later year), or null if never valid. */
function nextYmd(mo: number, d: number, t: { y: number; m: number; d: number }): string | null {
  const todayN = toDays(t.y, t.m, t.d);
  for (let y = t.y; y <= t.y + 8; y++) {
    if (validYmd(y, mo, d) && toDays(y, mo, d) >= todayN) return `${pad(y)}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

function monthRange(m: RegExpExecArray, t: { y: number; m: number; d: number }): DateVal | null {
  const mo = MON_KEYS.indexOf((grp(m, 'mo') ?? '').slice(0, 3).toLowerCase()) + 1;
  const mo2raw = grp(m, 'mo2');
  const mo2 = mo2raw ? MON_KEYS.indexOf(mo2raw.slice(0, 3).toLowerCase()) + 1 : mo;
  const d1 = Number(grp(m, 'd1'));
  const d2 = Number(grp(m, 'd2'));
  const start = nextYmd(mo, d1, t);
  if (!start || !mo || !mo2) return null;
  const y = Number(start.slice(0, 4));
  // "dec 28 - jan 3": the end is in the next year.
  const endYear = mo2 < mo ? y + 1 : y;
  if (!validYmd(endYear, mo2, d2)) return null;
  const end = `${pad(endYear)}-${pad(mo2)}-${pad(d2)}`;
  return end > start ? { date: start, end, tonight: false } : null;
}

function findTimes(text: string): Cand<TimeVal>[] {
  return [
    ...scan(RE_TIME, text, buildTime),
    ...scan(RE_WORD_TIME, text, (m) => ({
      start: grp(m, 'w')?.toLowerCase() === 'noon' ? 720 : 0,
      end: null,
    })),
  ];
}

function findDayparts(text: string): Cand<TimeVal>[] {
  const at = { morning: 540, afternoon: 900, evening: 1080 };
  return scan(RE_DAYPART, text, (m) => {
    const w = (grp(m, 'w') ?? '').toLowerCase() as keyof typeof at;
    return { start: at[w], end: null };
  });
}

function findPlace(
  input: string,
  stops: number[],
): { token: ParsedToken; place: string } | undefined {
  const at = RE_AT.exec(input);
  if (!at) return undefined;
  const atIdx = at.index + at[0].length - 1;
  let from = atIdx + 1;
  while (from < input.length && /\s/.test(input.charAt(from))) from++;
  const limit = Math.min(input.length, ...stops.filter((s) => s >= from));
  const text = input.slice(from, limit).trimEnd();
  if (!text) return undefined;
  const end = from + text.length;
  return {
    token: { type: 'place', text: input.slice(atIdx, end), start: atIdx, end },
    place: text,
  };
}

const RRULE_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const RE_REPEAT_DAYS = new RegExp(
  `(?<!\\w)every\\s+(?<other>other\\s+)?(?<a>${WD})s?(?:\\s*(?:,|and|&)\\s*(?<b>${WD})s?)?(?!\\w)`,
  'gi',
);
const REPEATS: [RegExp, string][] = [
  [/(?<!\w)(?:every\s+weekday|weekdays)(?!\w)/gi, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  [/(?<!\w)(?:every\s+weekend|weekends)(?!\w)/gi, 'FREQ=WEEKLY;BYDAY=SA,SU'],
  [/(?<!\w)(?:every\s+day|daily)(?!\w)/gi, 'FREQ=DAILY'],
  [
    /(?<!\w)(?:every\s+(?:other|2nd|second|two)\s+weeks?|every\s+2\s+weeks|fortnightly|biweekly)(?!\w)/gi,
    'FREQ=WEEKLY;INTERVAL=2',
  ],
  [/(?<!\w)(?:every\s+week|weekly)(?!\w)/gi, 'FREQ=WEEKLY'],
  [/(?<!\w)(?:every\s+month|monthly)(?!\w)/gi, 'FREQ=MONTHLY'],
  [/(?<!\w)(?:every\s+year|yearly|annually)(?!\w)/gi, 'FREQ=YEARLY'],
];

const wdIndex = (w: string): number => WD_KEYS.indexOf(w.slice(0, 3).toLowerCase());

const ORD = '(?<d>\\d{1,2})(?:st|nd|rd|th)?';
const RE_MONTH_DAY = new RegExp(
  [
    `(?:on\\s+)?the\\s+${ORD.replace('<d>', '<d1>')}\\s+(?:of\\s+)?(?:every|each)\\s+month`,
    `(?:every|each)\\s+month\\s+on\\s+the\\s+${ORD.replace('<d>', '<d2>')}`,
    `monthly\\s+on\\s+the\\s+${ORD.replace('<d>', '<d3>')}`,
  ]
    .map((x) => `(?<!\\w)${x}(?!\\w)`)
    .join('|'),
  'i',
);

/** "every …" phrases: the rule, where it is, and the first weekday it names (if any). */
function findRepeat(text: string): {
  start: number;
  end: number;
  rrule: string;
  firstDay: number | null;
  monthDay?: number;
} | null {
  const md = RE_MONTH_DAY.exec(text);
  if (md) {
    const d = Number(md.groups?.d1 ?? md.groups?.d2 ?? md.groups?.d3);
    if (d >= 1 && d <= 31)
      return {
        start: md.index,
        end: md.index + md[0].length,
        rrule: `FREQ=MONTHLY;BYMONTHDAY=${d}`,
        firstDay: null,
        monthDay: d,
      };
  }
  const days = new RegExp(RE_REPEAT_DAYS.source, 'i').exec(text);
  if (days) {
    const a = wdIndex(days.groups?.a ?? '');
    const b = days.groups?.b ? wdIndex(days.groups.b) : -1;
    if (a >= 0) {
      const byday = [a, b]
        .filter((d) => d >= 0)
        .sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7))
        .map((d) => RRULE_DAY[d])
        .join(',');
      return {
        start: days.index,
        end: days.index + days[0].length,
        rrule: `FREQ=WEEKLY;${days.groups?.other ? 'INTERVAL=2;' : ''}BYDAY=${byday}`,
        firstDay: a,
      };
    }
  }
  for (const [re, rrule] of REPEATS) {
    const m = new RegExp(re.source, 'i').exec(text);
    if (m) return { start: m.index, end: m.index + m[0].length, rrule, firstDay: null };
  }
  return null;
}

function cleanTitle(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').replace(EDGE_PUNCT, '');
  const words = s.split(' ').filter(Boolean);
  while (words.length > 1 && EDGE_WORDS.has((words[0] ?? '').toLowerCase())) words.shift();
  while (words.length > 1 && EDGE_WORDS.has((words[words.length - 1] ?? '').toLowerCase())) {
    words.pop();
  }
  s = words.join(' ').replace(EDGE_PUNCT, '');
  return s;
}

export function parseQuickAdd(input: string, ctx: QuickAddContext): QuickAddResult {
  const t = parseToday(ctx.today);
  const tokens: ParsedToken[] = [];
  const push = (type: TokenType, c: { start: number; end: number }) =>
    tokens.push({ type, text: input.slice(c.start, c.end), start: c.start, end: c.end });
  const stops: number[] = [];

  // "every …" first; it is masked so "every saturday" isn't also "this saturday"
  const repeat = findRepeat(input);
  const unrepeated = repeat
    ? input.slice(0, repeat.start) + ' '.repeat(repeat.end - repeat.start) + input.slice(repeat.end)
    : input;
  if (repeat) {
    push('repeat', repeat);
    stops.push(repeat.start);
  }

  // dates next; the chosen date is masked so it cannot be re-read as a time
  const dates = findDates(unrepeated, t, ctx.dateOrder, ctx.weekStart);
  const dateTok = first(dates);
  stops.push(...dates.map((d) => d.start));
  let masked = unrepeated;
  if (dateTok) {
    push('date', dateTok);
    masked =
      unrepeated.slice(0, dateTok.start) +
      ' '.repeat(dateTok.end - dateTok.start) +
      unrepeated.slice(dateTok.end);
  }

  const times = findTimes(masked);
  const parts = findDayparts(masked);
  stops.push(...times.map((x) => x.start), ...parts.map((x) => x.start));
  const timeTok = first(times) ?? first(parts);
  let time: number | null = null;
  let end: number | null = null;
  if (timeTok) {
    push('time', timeTok);
    time = timeTok.value.start;
    end = timeTok.value.end;
    if (end === null) {
      const untils = scan(RE_UNTIL, masked, (m) => {
        const p = getPart(m, 1);
        const v = p ? minutes(p, p.ap, true) : null;
        if (v === null || timeTok.end > (m.index ?? 0)) return null;
        return v <= (time ?? 0) && !p?.ap && v + 720 < 1440 ? v + 720 : v;
      });
      stops.push(...untils.map((x) => x.start));
      const u = first(untils);
      if (u) {
        push('time', u);
        end = u.value;
      }
    }
    if (end === null) {
      const fors = scan(RE_FOR, masked, (m) => {
        if (timeTok.end > (m.index ?? 0)) return null;
        if (grp(m, 'half')) return 30;
        const raw = (grp(m, 'n') ?? '').toLowerCase();
        const n = NUM_WORDS[raw] ?? Number(raw);
        if (!Number.isFinite(n) || n <= 0) return null;
        const mins = (grp(m, 'u') ?? '').toLowerCase().startsWith('h') ? n * 60 : n;
        return mins > 0 && mins <= 24 * 60 ? Math.round(mins) : null;
      });
      const f = first(fors);
      if (f && time !== null) {
        stops.push(f.start);
        push('time', f);
        end = (time + f.value) % (24 * 60);
      }
    }
  }

  const priv = RE_PRIVATE.exec(input);
  const askM = RE_ASK.exec(input);
  if (priv) stops.push(priv.index);
  if (askM) stops.push(askM.index);
  const placeRes = findPlace(input, stops);
  if (placeRes) tokens.push(placeRes.token);
  if (priv) push('privacy', { start: priv.index, end: priv.index + priv[0].length });
  if (askM) push('ask', { start: askM.index, end: askM.index + (askM[1] ?? '').length });

  tokens.sort((a, b) => a.start - b.start);
  let rest = '';
  let cur = 0;
  for (const tok of tokens) {
    rest += `${input.slice(cur, tok.start)} `;
    cur = tok.end;
  }
  rest += input.slice(cur);

  if (time === null && dateTok?.value.tonight) time = 19 * 60;
  // "every monday" with no date starts on the next Monday (today counts).
  let date = dateTok?.value.date ?? null;
  if (!date && repeat?.firstDay !== null && repeat?.firstDay !== undefined) {
    const today = toDays(t.y, t.m, t.d);
    const n = today + ((repeat.firstDay - dowOf(today) + 7) % 7);
    date = fromDays(n);
  }
  // "on the 1st every month" starts on the next 1st (today counts).
  if (!date && repeat?.monthDay) {
    for (let k = 0; k < 24 && !date; k++) {
      const y = t.y + Math.floor((t.m - 1 + k) / 12);
      const mo = ((t.m - 1 + k) % 12) + 1;
      if (validYmd(y, mo, repeat.monthDay) && (k > 0 || repeat.monthDay >= t.d))
        date = `${pad(y)}-${pad(mo)}-${pad(repeat.monthDay)}`;
    }
  }
  return {
    title: cleanTitle(rest),
    date,
    endDate: dateTok?.value.end ?? null,
    time: time === null ? null : fmtMin(time),
    endTime: end === null ? null : fmtMin(end),
    allDay: dateTok !== undefined && time === null,
    place: placeRes?.place ?? null,
    private: priv !== null,
    ask: askM !== null,
    rrule: repeat?.rrule ?? null,
    tokens,
  };
}
