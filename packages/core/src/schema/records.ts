// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plaintext record kinds. These shapes exist only on devices, inside
 * ciphertext. Every record carries its kind, schema version and the
 * authenticated write metadata used for conflict resolution.
 */
import * as v from 'valibot';
import { fromUtf8, utf8 } from '../crypto/bytes';
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

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WhenFields {
  start: string;
  end: string;
  all_day: boolean;
  tz: string | null;
}

/** Timed events use LocalDateTime + tz; all-day events use LocalDate (end exclusive) and no tz. */
export function isValidWhen(e: WhenFields): boolean {
  const dateOnly = e.start.length === 10 && e.end.length === 10;
  const timed = e.start.length === 16 && e.end.length === 16;
  if (e.all_day) return dateOnly && e.tz === null && e.end > e.start;
  return timed && e.tz !== null && e.end >= e.start;
}

const whenEntries = {
  start: v.union([LocalDate, LocalDateTime]),
  end: v.union([LocalDate, LocalDateTime]),
  all_day: v.boolean(),
  tz: v.nullable(TimeZone),
  rrule: v.nullable(Text(500)),
  /** Out of town / unavailable all day (e.g. a work trip): blocks "both free" evenings. */
  away: v.boolean(),
};
const WHEN_MESSAGE = 'start/end must match all_day, end must not precede start';

export const EventData = v.pipe(
  v.strictObject({
    ...whenEntries,
    title: NonEmpty(200),
    owner: Owner,
    status: v.picklist(['confirmed', 'proposed']),
    proposed_by: v.nullable(Slot),
    privacy: v.picklist(['full', 'busy']),
    location: v.nullable(Text(200)),
    notes: v.nullable(Text(4000)),
    countdown: v.boolean(),
    /** For privacy 'busy': id of the shared busy_stub that shadows this event. */
    stub_id: v.nullable(RefId),
  }),
  v.check((e) => isValidWhen(e), WHEN_MESSAGE),
);

export const BusyStubData = v.pipe(
  v.strictObject({ ...whenEntries, owner: Slot }),
  v.check((e) => isValidWhen(e), WHEN_MESSAGE),
);

export const ListData = v.strictObject({
  name: NonEmpty(100),
  kind: v.picklist(['check', 'ideas']),
  private: v.boolean(),
});

export const ItemData = v.strictObject({
  list_id: RefId,
  text: NonEmpty(500),
  done: v.boolean(),
  assignee: v.nullable(Owner),
  due: v.nullable(LocalDate),
  sort_key: v.custom<string>(isSortKey, 'Invalid sort key'),
});

export const CommentData = v.strictObject({
  parent_id: RefId,
  text: NonEmpty(2000),
  author: Slot,
});

export const CHECKIN_STEPS = ['week', 'chores', 'time', 'note'] as const;
export const CheckinData = v.strictObject({
  date: LocalDate,
  steps_done: v.pipe(v.array(v.picklist(CHECKIN_STEPS)), v.maxLength(CHECKIN_STEPS.length)),
  note: v.nullable(Text(4000)),
});

const Member = v.strictObject({ name: NonEmpty(40), color: Color, user_id: RefId });

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
  members: v.optional(v.strictObject({ a: v.optional(Member), b: v.optional(Member) })),
  theme: v.optional(v.picklist(['system', 'light', 'dark'])),
});

export const KIND_SCHEMAS = {
  event: EventData,
  busy_stub: BusyStubData,
  list: ListData,
  item: ItemData,
  comment: CommentData,
  checkin: CheckinData,
  settings: SettingsData,
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

/** Current schema version per kind. Bump together with a migration below. */
export const CURRENT_SCHEMA: Record<Kind, number> = {
  event: 1,
  busy_stub: 1,
  list: 1,
  item: 1,
  comment: 1,
  checkin: 1,
  settings: 1,
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
