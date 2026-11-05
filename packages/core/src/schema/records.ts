// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plaintext record kinds. These shapes exist only on devices, inside
 * ciphertext. Every record carries its kind, schema version and the
 * authenticated write metadata used for conflict resolution.
 */
import * as v from 'valibot';
import { fromUtf8, utf8 } from '../crypto/bytes';
import { isValidRRule } from '../time/recurrence';
import { isSortKey } from './sortkey';

const Text = (max: number) => v.pipe(v.string(), v.maxLength(max));
const NonEmpty = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
const RefId = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
export const LocalDate = v.pipe(v.string(), v.isoDate());
/** Wall-clock time in the event's zone, no offset: 2026-11-06T19:00 */
export const LocalDateTime = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/));
export const HHmm = v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/));
export const TimeZone = v.pipe(
  v.string(),
  v.maxLength(64),
  v.check(isTimeZone, 'Unknown time zone'),
);
const Slot = v.picklist(['a', 'b']);
const Owner = v.picklist(['a', 'b', 'both']);
const Color = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/i));

const zoneCache = new Map<string, boolean>();

/** True for IANA zones the runtime knows. Cached: constructing Intl formatters is slow. */
export function isTimeZone(tz: string): boolean {
  let ok = zoneCache.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    if (zoneCache.size < 1000) zoneCache.set(tz, ok);
  }
  return ok;
}

interface WhenFields {
  start: string;
  end: string;
  all_day: boolean;
  tz: string | null;
  rrule?: string | null;
  except?: { at: string; to: { start: string; end: string } | null }[] | undefined;
}

/** Timed events use LocalDateTime + tz; all-day events use LocalDate (end exclusive) and no tz. */
export function isValidWhen(e: WhenFields): boolean {
  const dateOnly = e.start.length === 10 && e.end.length === 10;
  const timed = e.start.length === 16 && e.end.length === 16;
  const ok = e.all_day
    ? dateOnly && e.tz === null && e.end > e.start
    : timed && e.tz !== null && e.end >= e.start;
  if (!ok) return false;
  // Exceptions only on repeating plans, in the same form as the plan's times.
  const len = e.all_day ? 10 : 16;
  return (e.except ?? []).every(
    (x) =>
      !!e.rrule &&
      x.at.length === len &&
      (x.to === null ||
        (x.to.start.length === len &&
          x.to.end.length === len &&
          (e.all_day ? x.to.end > x.to.start : x.to.end >= x.to.start))),
  );
}

/** Most exceptions a repeating plan keeps (skipped or moved days). */
export const MAX_EXCEPTIONS = 200;

/**
 * One day of a repeating plan, changed on its own: skipped (`to: null`) or
 * moved to other times. `at` is that day's original start, in the plan's form
 * (a date for all-day plans, a wall-clock date and time otherwise).
 */
const Exception = v.strictObject({
  at: v.union([LocalDate, LocalDateTime]),
  to: v.nullable(
    v.strictObject({
      start: v.union([LocalDate, LocalDateTime]),
      end: v.union([LocalDate, LocalDateTime]),
    }),
  ),
});

const whenEntries = {
  start: v.union([LocalDate, LocalDateTime]),
  end: v.union([LocalDate, LocalDateTime]),
  all_day: v.boolean(),
  tz: v.nullable(TimeZone),
  rrule: v.nullable(Text(500)),
  except: v.optional(v.pipe(v.array(Exception), v.maxLength(MAX_EXCEPTIONS))),
  /** Out of town / unavailable all day (e.g. a work trip): blocks "both free" evenings. */
  away: v.boolean(),
};
const WHEN_MESSAGE = 'start/end must match all_day, end must not precede start';

/**
 * Reminder offsets in minutes before the start, up to four weeks. All-day
 * plans count from 9 AM on the day, so a negative offset (down to -899) is a
 * time later that day, up to 11:59 PM.
 */
export const REMINDER_MIN = -899;
export const REMINDER_MAX = 28 * 24 * 60 + 540;
const ReminderMinutes = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(REMINDER_MIN),
  v.maxValue(REMINDER_MAX),
);
export const MAX_REMINDERS_PER_PERSON = 3;
const PersonReminders = v.nullable(
  v.union([
    ReminderMinutes,
    v.pipe(v.array(ReminderMinutes), v.maxLength(MAX_REMINDERS_PER_PERSON)),
  ]),
);

export const EventData = v.pipe(
  v.strictObject({
    ...whenEntries,
    title: NonEmpty(200),
    owner: Owner,
    /** `declined`: the partner can't make it; only the proposer still sees it. */
    status: v.picklist(['confirmed', 'proposed', 'declined']),
    proposed_by: v.nullable(Slot),
    privacy: v.picklist(['full', 'busy']),
    location: v.nullable(Text(200)),
    notes: v.nullable(Text(4000)),
    countdown: v.boolean(),
    /** For privacy 'busy': id of the shared busy_stub that shadows this event. */
    stub_id: v.nullable(RefId),
    /**
     * Each person's own reminders: minutes before the start (all-day plans:
     * before 9 AM on the day), up to three; a single number or null also parse.
     */
    remind: v.optional(v.strictObject({ a: PersonReminders, b: PersonReminders })),
    /** The idea it was planned from (a list item), so the idea shows it's planned. */
    from_item: v.optional(v.nullable(RefId)),
  }),
  v.check((e) => isValidWhen(e), WHEN_MESSAGE),
);

export const BusyStubData = v.pipe(
  v.strictObject({ ...whenEntries, owner: Slot }),
  v.check((e) => isValidWhen(e), WHEN_MESSAGE),
);

/**
 * List types. The app offers one general type and three special ones:
 * - todo: the general list (groceries, to-dos, packing), tick-off with assignees
 * - chores: older name for a general list in the weekly check-in (now the
 *   `checkin` flag, which any shared list can have)
 * - ideas: date ideas with "pick one for us" and "plan it"
 * - gifts: tick-off, private by default so surprises stay surprises
 * 'shopping' and 'check' are older names for the general list and still parse.
 */
export const LIST_KINDS = ['shopping', 'chores', 'todo', 'ideas', 'gifts', 'check'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/**
 * What a list can do, each switched on or off in its settings. A list
 * without `features` (made before they existed) gets defaults from its kind.
 * - tick: items are ticked off (otherwise they're ideas, kept until removed)
 * - who: who's on it, and taking turns on repeating ones (shared lists)
 * - due: due dates and repeats
 * - pick: "pick one for us"
 * - plan: "plan it" turns an item into a plan
 * - length: roughly how long, to fit your free time
 * - hearts: each of you can heart an item; "we both want" filter
 * - did: "we did it", with when and how it was, and "do again"
 * - when: soon or someday, and seasons
 * - notes, qty, link, price, sections: details on each item
 */
export const LIST_FEATURES = [
  'tick',
  'who',
  'due',
  'pick',
  'plan',
  'length',
  'hearts',
  'did',
  'when',
  'notes',
  'qty',
  'link',
  'price',
  'sections',
] as const;
export type ListFeature = (typeof LIST_FEATURES)[number];

/** Starting points: each switches on a set of features (the app keeps the sets). */
export const LIST_TEMPLATES = [
  'blank',
  'groceries',
  'todo',
  'chores',
  'dates',
  'watch',
  'restaurants',
  'gifts',
  'packing',
  'bucket',
  'custom',
] as const;
export type ListTemplate = (typeof LIST_TEMPLATES)[number];

const Features = v.pipe(v.array(v.picklist(LIST_FEATURES)), v.maxLength(LIST_FEATURES.length));

export const ListData = v.strictObject({
  name: NonEmpty(100),
  kind: v.picklist(LIST_KINDS),
  private: v.boolean(),
  /** Its open items come up in the weekly check-in to share out (shared lists only). */
  checkin: v.optional(v.boolean()),
  /** What this list can do (see LIST_FEATURES); absent on older lists. */
  features: v.optional(Features),
  /** The starting point it was made from. */
  template: v.optional(v.picklist(LIST_TEMPLATES)),
  /** A checklist for this plan (packing, getting ready). */
  plan_id: v.optional(v.nullable(RefId)),
  /*
   * Fields added later are optional, so lists written without them stay
   * readable by older versions of the app. An older app that meets one with
   * them keeps its own copy and reads it again once it updates
   * (src/account/sync.ts), so nothing is overwritten meanwhile.
   */
  /** Where it sits among the lists (absent: after those that have one, oldest first). */
  sort_key: v.optional(v.custom<string>(isSortKey, 'Invalid sort key')),
  /** Kept at the top of the lists. */
  pinned: v.optional(v.boolean()),
  /** Put away: out of the switcher, the check-in and the views across lists; still searchable. */
  archived: v.optional(v.boolean()),
  /** Section names in their order (store aisles, days of a trip). */
  sections: v.optional(v.pipe(v.array(NonEmpty(60)), v.maxLength(60))),
  /** How its items are ordered: its own order, by due date, by who, A to Z or newest first. */
  order: v.optional(v.picklist(['own', 'due', 'who', 'az', 'recent'])),
  /** Holds a saved starting point's items: never shown as a list of its own. */
  stash: v.optional(v.boolean()),
});

/** How "we did it" was, for each of you. */
export const REACTIONS = ['loved', 'good', 'meh'] as const;
export type Reaction = (typeof REACTIONS)[number];
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

/** Rough lengths for date ideas, with the minutes each needs free. */
export const IDEA_LENGTHS = {
  short: 90,
  evening: 180,
  half: 300,
  day: 600,
} as const;
export type IdeaLength = keyof typeof IDEA_LENGTHS;

export const ItemData = v.strictObject({
  list_id: RefId,
  text: NonEmpty(500),
  done: v.boolean(),
  assignee: v.nullable(Owner),
  due: v.nullable(LocalDate),
  sort_key: v.custom<string>(isSortKey, 'Invalid sort key'),
  /**
   * A repeating task: ticking it moves `due` to the next date instead of
   * finishing it (RRULE value, e.g. FREQ=WEEKLY;BYDAY=MO).
   */
  repeat: v.optional(v.nullable(v.pipe(Text(200), v.check(isValidRRule, 'Invalid repeat')))),
  /** Take turns: each time it's done, it passes to the other person. */
  rotate: v.optional(v.boolean()),
  /** When a repeating task was last done. */
  last_done: v.optional(v.nullable(LocalDate)),
  /** Date ideas: roughly how long it takes, if anyone said (see IDEA_LENGTHS). */
  length: v.optional(v.nullable(v.picklist(['short', 'evening', 'half', 'day']))),
  /** Details, each shown when its list has that feature. */
  note: v.optional(v.nullable(Text(2000))),
  qty: v.optional(v.nullable(Text(30))),
  /** A web address, kept as text: never fetched or previewed. */
  link: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(2048), v.regex(/^https?:\/\/[^\s]+$/))),
  ),
  /** Price in hundredths (cents, pence). */
  price: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1e11)))),
  section: v.optional(v.nullable(Text(60))),
  /** Who hearted it ("we both want"). */
  hearts: v.optional(v.strictObject({ a: v.optional(v.boolean()), b: v.optional(v.boolean()) })),
  /** "We did it": when, and how it was for each of you. */
  did: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          date: LocalDate,
          a: v.optional(v.picklist(REACTIONS)),
          b: v.optional(v.picklist(REACTIONS)),
        }),
      ),
      v.maxLength(100),
    ),
  ),
  /** Worth doing again: a favourite. */
  again: v.optional(v.boolean()),
  when: v.optional(v.nullable(v.picklist(['soon', 'someday']))),
  season: v.optional(
    v.pipe(v.array(v.picklist(['spring', 'summer', 'autumn', 'winter'])), v.maxLength(4)),
  ),
  /** On a plan's checklist: due this many days before the plan. */
  before_days: v.optional(
    v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(365))),
  ),
});

export const CommentData = v.strictObject({
  parent_id: RefId,
  text: NonEmpty(2000),
  author: Slot,
});

export const CHECKIN_STEPS = ['week', 'chores', 'time', 'note'] as const;
export const CheckinData = v.strictObject({
  date: LocalDate,
  author: Slot,
  steps_done: v.pipe(v.array(v.picklist(CHECKIN_STEPS)), v.maxLength(CHECKIN_STEPS.length)),
  note: v.nullable(Text(4000)),
});

/** Colours each person can pick (light and dark versions live in the web app's tokens). */
export const PERSON_COLORS = [
  'blue',
  'rose',
  'teal',
  'green',
  'amber',
  'red',
  'slate',
  'brown',
] as const;
export type PersonColor = (typeof PERSON_COLORS)[number];
/** Marker shapes: different shapes tell the two of you apart without colour. */
export const PERSON_SHAPES = ['circle', 'square', 'diamond'] as const;
export type PersonShape = (typeof PERSON_SHAPES)[number];

const Member = v.strictObject({
  name: NonEmpty(40),
  /** Older hex colour, kept so existing records parse; `palette` is what's shown. */
  color: Color,
  user_id: RefId,
  palette: v.optional(v.picklist(PERSON_COLORS)),
  shape: v.optional(v.picklist(PERSON_SHAPES)),
});

const DefaultReminders = v.strictObject({
  timed: v.pipe(v.array(ReminderMinutes), v.maxLength(MAX_REMINDERS_PER_PERSON)),
  all_day: v.pipe(v.array(ReminderMinutes), v.maxLength(MAX_REMINDERS_PER_PERSON)),
});

/** Shared settings live in space scope; personal ones in user scope. All fields optional. */
export const SettingsData = v.strictObject({
  week_start: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))),
  quiet_hours: v.optional(v.nullable(v.strictObject({ start: HHmm, end: HHmm }))),
  notify: v.optional(
    v.strictObject({
      proposals: v.boolean(),
      reminders: v.boolean(),
      checkin: v.boolean(),
    }),
  ),
  default_reminder_minutes: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
  /** Each person's default reminders for new plans (timed and all-day), up to three each. */
  default_reminders: v.optional(
    v.strictObject({
      a: v.optional(DefaultReminders),
      b: v.optional(DefaultReminders),
    }),
  ),
  members: v.optional(v.strictObject({ a: v.optional(Member), b: v.optional(Member) })),
  theme: v.optional(v.picklist(['system', 'light', 'dark'])),
  /** Unused since review 0004 (L4); kept so older records still parse. */
  feed_include_partner: v.optional(v.boolean()),
  /**
   * Calendar feed (review 0004, L4): `feed_share_busy[x]` is x's consent for
   * the partner to put x's busy times in the partner's (plaintext) feed;
   * `feed_include[x]` is x's choice to do so. Both must be true.
   */
  feed_share_busy: v.optional(
    v.strictObject({ a: v.optional(v.boolean()), b: v.optional(v.boolean()) }),
  ),
  feed_include: v.optional(
    v.strictObject({ a: v.optional(v.boolean()), b: v.optional(v.boolean()) }),
  ),
  /** Which shared check list the weekly check-in uses for chores. */
  chores_list: v.optional(v.nullable(RefId)),
  /**
   * `notify_notes[x]` false: x doesn't want a notification when the partner
   * adds a note to a plan. Checked by the sender's device (phones must show
   * every push they get, so the receiver can't quietly drop one).
   */
  notify_notes: v.optional(
    v.strictObject({ a: v.optional(v.boolean()), b: v.optional(v.boolean()) }),
  ),
  /** Starting points the two of you saved from your own lists. */
  /** When "both free this evening" looks (shift workers' evenings differ). */
  evening: v.optional(v.strictObject({ start: HHmm, end: HHmm })),
  list_templates: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          id: RefId,
          name: NonEmpty(40),
          features: Features,
          private: v.boolean(),
          /** The hidden list holding its items, when it was saved with them. */
          list_id: v.optional(RefId),
        }),
      ),
      v.maxLength(12),
    ),
  ),
});

/**
 * A calendar the user already has, imported by subscription link (or a
 * one-time file). Always stored under the importer's personal key: the URL is
 * a secret that grants read access to that calendar.
 */
export const CalendarData = v.strictObject({
  name: NonEmpty(80),
  /** https:// feed URL (webcal:// is normalised), or null for a one-time file import. */
  url: v.nullable(v.pipe(v.string(), v.maxLength(2048), v.regex(/^https?:\/\//))),
  /** Whose calendar this is. */
  owner: Owner,
  /** What the partner sees: everything, or only busy blocks. */
  share: v.picklist(['full', 'busy']),
  /** Last successful refresh (ms), or null. */
  fetched_at: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

/** One occurrence in a calendar snapshot (already expanded; no recurrence). */
const SnapshotItem = v.strictObject({
  start: v.union([LocalDate, LocalDateTime]),
  end: v.union([LocalDate, LocalDateTime]),
  all_day: v.boolean(),
  tz: v.nullable(TimeZone),
  /** Present only in full-detail snapshots. */
  title: v.optional(Text(200)),
  location: v.optional(v.nullable(Text(200))),
  /** Marked free/transparent in the source calendar: shown, but not busy. */
  free: v.optional(v.literal(true)),
});

export const MAX_SNAPSHOT_ITEMS = 400;

/**
 * The events of an imported calendar for a window (e.g. the next 60 days),
 * written by the importer's device after each refresh. A 'busy' snapshot
 * carries times only; the importer keeps a 'full' copy under their own key.
 */
export const CalSnapshotData = v.pipe(
  v.strictObject({
    calendar_id: RefId,
    /** Who imported it (holds the URL). Their own feed leaves this calendar out. */
    importer: Slot,
    /** Calendar name; omitted from busy-only snapshots shared with the partner. */
    name: v.optional(NonEmpty(80)),
    owner: Owner,
    detail: v.picklist(['full', 'busy']),
    window_start: LocalDate,
    window_end: LocalDate,
    fetched_at: v.pipe(v.number(), v.integer(), v.minValue(0)),
    items: v.pipe(v.array(SnapshotItem), v.maxLength(MAX_SNAPSHOT_ITEMS)),
  }),
  v.check(
    (s) =>
      s.detail === 'full' ||
      (s.name === undefined && s.items.every((i) => i.title === undefined && i.location == null)),
    'Busy-only snapshots must not carry names, titles or places',
  ),
);

export const KIND_SCHEMAS = {
  event: EventData,
  busy_stub: BusyStubData,
  list: ListData,
  item: ItemData,
  comment: CommentData,
  checkin: CheckinData,
  settings: SettingsData,
  calendar: CalendarData,
  cal_snapshot: CalSnapshotData,
} as const;

export type Kind = keyof typeof KIND_SCHEMAS;
export const KINDS = Object.keys(KIND_SCHEMAS) as Kind[];
export type KindData = { [K in Kind]: v.InferOutput<(typeof KIND_SCHEMAS)[K]> };
export type EventData = KindData['event'];
export type BusyStubData = KindData['busy_stub'];
export type ListData = KindData['list'];
export type ItemData = KindData['item'];
export type CommentData = KindData['comment'];
export type CheckinData = KindData['checkin'];
export type SettingsData = KindData['settings'];
export type CalendarData = KindData['calendar'];
export type CalSnapshotData = KindData['cal_snapshot'];

/** Current schema version per kind. Bump together with a migration below. */
export const CURRENT_SCHEMA: Record<Kind, number> = {
  event: 1,
  busy_stub: 1,
  list: 1,
  item: 1,
  comment: 1,
  checkin: 1,
  settings: 1,
  calendar: 1,
  cal_snapshot: 1,
};

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;
/**
 * MIGRATIONS[kind][n] upgrades data from schema n to n + 1.
 * Migrations run on device after decryption and must be pure.
 */
export const MIGRATIONS: Partial<Record<Kind, Record<number, Migration>>> = {};

/** Upper bound for write timestamps (~ year 10889), so one bad write cannot freeze a record. */
export const MAX_TIMESTAMP = 2 ** 48;

/** Thrown for invalid record content. Never includes the offending values. */
export class RecordError extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(`Invalid record${paths.length ? ` at ${paths.join(', ')}` : ''}`);
    this.name = 'RecordError';
    this.paths = paths;
  }
}

function issuePaths(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return issues.map((i) => i.path?.map((p) => String(p.key)).join('.') ?? '').filter(Boolean);
}

/** Write metadata, authenticated because it sits inside the ciphertext. */
export interface RecordMeta {
  /** Milliseconds; monotonic per record (see sync/clock.ts). */
  updated_at: number;
  device_id: string;
}

export type DecodedRecord =
  | ({ [K in Kind]: { kind: K; deleted: false; data: KindData[K] } }[Kind] & RecordMeta)
  | ({ kind: Kind; deleted: true; data: null } & RecordMeta);

const Meta = v.object({
  kind: v.picklist(KINDS),
  schema: v.pipe(v.number(), v.integer(), v.minValue(1)),
  updated_at: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_TIMESTAMP)),
  device_id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  deleted: v.boolean(),
  data: v.unknown(),
});

export type DecodeResult =
  | { ok: true; record: DecodedRecord }
  | { ok: false; reason: 'newer-schema' | 'invalid' };

/** Validates and serialises a record for encryption. Throws RecordError on invalid data. */
export function encodeRecord(record: DecodedRecord): Uint8Array {
  const meta = v.safeParse(Meta, { ...record, schema: CURRENT_SCHEMA[record.kind] });
  if (!meta.success) throw new RecordError(issuePaths(meta.issues));
  let data: unknown = null;
  if (!record.deleted) {
    const parsed = v.safeParse(KIND_SCHEMAS[record.kind], record.data);
    if (!parsed.success) throw new RecordError(issuePaths(parsed.issues));
    data = parsed.output;
  }
  return utf8(
    JSON.stringify({
      kind: record.kind,
      schema: CURRENT_SCHEMA[record.kind],
      updated_at: record.updated_at,
      device_id: record.device_id,
      deleted: record.deleted,
      data,
    }),
  );
}

/** Validates data for a kind without throwing; used after merges. */
export function isValidData(kind: Kind, data: unknown): boolean {
  return v.is(KIND_SCHEMAS[kind], data);
}

/**
 * Parses decrypted bytes, running migrations for older schema versions.
 * Records from a newer app version are reported, never rewritten, so an
 * old device cannot clobber data it does not understand.
 */
export function decodeRecord(bytes: Uint8Array): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(bytes));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const meta = v.safeParse(Meta, json);
  if (!meta.success) return { ok: false, reason: 'invalid' };
  const { kind, schema, updated_at, device_id, deleted } = meta.output;
  const current = CURRENT_SCHEMA[kind];
  if (schema > current) return { ok: false, reason: 'newer-schema' };
  if (deleted) {
    return { ok: true, record: { kind, deleted: true, data: null, updated_at, device_id } };
  }
  let data = meta.output.data;
  for (let s = schema; s < current; s++) {
    const step = MIGRATIONS[kind]?.[s];
    if (!step || typeof data !== 'object' || data === null) return { ok: false, reason: 'invalid' };
    data = step(data as Record<string, unknown>);
  }
  const parsed = v.safeParse(KIND_SCHEMAS[kind], data);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    record: { kind, deleted: false, data: parsed.output, updated_at, device_id } as DecodedRecord,
  };
}
