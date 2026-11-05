// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client-side conflict resolution on decrypted records.
 *
 * - Default: last-writer-wins per record (see clock.ts for the order).
 * - Kinds in FIELD_MERGE_KINDS merge field by field against the common base:
 *   a field changed on one side only takes that side's value; a field
 *   changed on both sides takes the later writer's value.
 * - Deletion wins over a concurrent edit only if it is the later write.
 * - Comments never conflict: each is its own append-only record.
 *
 * Because the timestamps are inside the ciphertext, a server replaying an
 * old version of a record loses to the newer version the device holds.
 */
import { type DecodedRecord, isValidData, type Kind, MAX_EXCEPTIONS } from '../schema/records';
import { compareWrites, nextTimestamp } from './clock';

export const FIELD_MERGE_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  'item',
  'list',
  'settings',
  'event',
  'busy_stub',
]);

/**
 * Plans' fields that only make sense together, merged as one unit: the
 * time (never half of a move), the answer (yes from one side, "can't make
 * it" from the other: the later wins), and privacy with its Busy marker.
 * Each person's reminders merge on their own (`remind.a`, `remind.b`), and
 * skipped or moved days merge day by day (review 0009, P-5).
 */
// `away` too: it only means something on an all-day plan.
const WHEN = ['start', 'end', 'all_day', 'tz', 'rrule', 'away'];
const UNITS: Partial<Record<Kind, string[][]>> = {
  // `was` describes one change as a whole: never half of two.
  event: [WHEN, ['status', 'proposed_by'], ['privacy', 'stub_id'], ['was']],
  busy_stub: [WHEN],
};

/** Copies each unit whole from the side that changed it (the later writer if both did). */
function mergeUnits(
  out: Record<string, unknown>,
  b: Record<string, unknown>,
  l: Record<string, unknown>,
  r: Record<string, unknown>,
  units: string[][],
  localWins: boolean,
): Record<string, unknown> | null {
  let whenFrom: Record<string, unknown> | null = null;
  for (const unit of units) {
    const lc = unit.some((k) => !sameJson(l[k], b[k]));
    const rc = unit.some((k) => !sameJson(r[k], b[k]));
    const from = lc && rc ? (localWins ? l : r) : lc ? l : rc ? r : b;
    for (const k of unit) {
      if (from[k] === undefined) delete out[k];
      else out[k] = from[k];
    }
    if (unit === WHEN && (lc || rc)) whenFrom = from;
  }
  return whenFrom;
}

type Except = { at: string; to: unknown };

/** Whether a side repeats on the same days as the base (it may have moved the time of day). */
function sameDays(b: Record<string, unknown>, x: Record<string, unknown>): boolean {
  return (
    x.rrule === b.rrule &&
    x.all_day === b.all_day &&
    x.tz === b.tz &&
    String(x.start).slice(0, 10) === String(b.start).slice(0, 10)
  );
}

/**
 * Skipped days when a side changed the time. If both sides still repeat on
 * the base's days (only the time of day or length changed), all three
 * lists are named by the new time of day and merged day by day, so a day
 * the other side skipped, put back or changed meanwhile isn't lost. If the
 * days themselves changed, the old names no longer fit: the changing
 * side's list stands, as editing the series does.
 */
function exceptAfterMove(
  b: Record<string, unknown>,
  l: Record<string, unknown>,
  r: Record<string, unknown>,
  w: Record<string, unknown>,
  localWins: boolean,
): unknown {
  if (!sameDays(b, l) || !sameDays(b, r)) return w.except;
  const time = String(w.start).slice(10);
  const rekey = (x: unknown) =>
    Array.isArray(x) ? (x as Except[]).map((e) => ({ ...e, at: e.at.slice(0, 10) + time })) : x;
  return mergeExcept(rekey(b.except), rekey(l.except), rekey(r.except), localWins);
}

/**
 * Skipped and moved days, three-way by day: a day skipped on one phone and
 * another on the other keeps both; the same day changed on both takes the
 * later writer's. Sorted, so both phones end up with the same list.
 */
function mergeExcept(b: unknown, l: unknown, r: unknown, localWins: boolean): Except[] {
  const map = (x: unknown) =>
    new Map((Array.isArray(x) ? (x as Except[]) : []).map((e) => [e.at, e] as const));
  const [mb, ml, mr] = [map(b), map(l), map(r)];
  const out: Except[] = [];
  for (const at of new Set([...mb.keys(), ...ml.keys(), ...mr.keys()])) {
    const [bv, lv, rv] = [mb.get(at), ml.get(at), mr.get(at)];
    const lc = !sameJson(lv, bv);
    const rc = !sameJson(rv, bv);
    const v = lc && rc ? (localWins ? lv : rv) : lc ? lv : rv;
    if (v) out.push(v);
  }
  // Over the limit the record wouldn't be valid, and the whole merge would
  // fall back to the later write: keep the latest days instead.
  return out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).slice(-MAX_EXCEPTIONS);
}

export type MergeOutcome =
  /** Remote is the result. Store it; nothing to push. */
  | { action: 'take-remote'; record: DecodedRecord }
  /** Local wins outright. Keep it and push it (with base_rev = remote rev). */
  | { action: 'keep-local'; record: DecodedRecord }
  /** A new record combining both sides. Store it and push it. */
  | { action: 'merged'; record: DecodedRecord };

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Three-way merge of object fields. Plain-object fields are merged
 * recursively up to `depth` more levels (so editing settings.members.a and
 * settings.members.b on different devices keeps both); anything else is
 * taken from the side that changed it, or from the later writer if both did.
 */
function mergeFields(
  b: Record<string, unknown>,
  l: Record<string, unknown>,
  r: Record<string, unknown>,
  localWins: boolean,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
    if (UNSAFE_KEYS.has(key)) continue;
    const bv = b[key];
    const lv = l[key];
    const rv = r[key];
    const localChanged = !sameJson(lv, bv);
    const remoteChanged = !sameJson(rv, bv);
    let value: unknown;
    if (localChanged && remoteChanged) {
      value =
        depth > 0 && isPlainObject(bv) && isPlainObject(lv) && isPlainObject(rv)
          ? mergeFields(bv, lv, rv, localWins, depth - 1)
          : localWins
            ? lv
            : rv;
    } else value = localChanged ? lv : rv;
    if (value !== undefined) out[key] = value;
  }
  return { ...out };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param base   last version both sides agreed on (the last synced version), if known
 * @param local  this device's current version, or undefined if it has none
 * @param remote the version from the server
 * @param hasPendingLocal whether `local` has unpushed changes
 * @param writer   this device, used to stamp a merged result as a new write
 */
/** A list's fields that only say where and how it's shown, not what it holds. */
const LAYOUT_FIELDS = new Set(['sort_key', 'pinned', 'archived', 'sections', 'order']);

function onlyLayout(base: Record<string, unknown> | null, live: Record<string, unknown> | null) {
  if (!base || !live) return false;
  for (const key of new Set([...Object.keys(base), ...Object.keys(live)]))
    if (!LAYOUT_FIELDS.has(key) && !sameJson(base[key], live[key])) return false;
  return true;
}

export function mergeRecord(
  base: DecodedRecord | undefined,
  local: DecodedRecord | undefined,
  remote: DecodedRecord,
  hasPendingLocal: boolean,
  writer: { now: number; device_id: string },
): MergeOutcome {
  if (!local) return { action: 'take-remote', record: remote };
  const order = compareWrites(local, remote);
  if (order === 0) return { action: 'take-remote', record: remote };

  if (!hasPendingLocal) {
    // Remote is normally newer. If it is older, it is a replay or a lost
    // update; keep ours and re-push it so the server heals.
    return order < 0
      ? { action: 'take-remote', record: remote }
      : { action: 'keep-local', record: local };
  }

  // A list deleted on one side (or re-created under the other key when made
  // private) and only rearranged on the other stays deleted: an empty copy
  // must not come back because the other phone moved or pinned it.
  if (base && !base.deleted && remote.kind === 'list' && local.deleted !== remote.deleted) {
    const live = local.deleted ? remote : local;
    if (onlyLayout(base.data as Record<string, unknown>, live.data as Record<string, unknown>))
      return local.deleted
        ? { action: 'keep-local', record: local }
        : { action: 'take-remote', record: remote };
  }

  const canFieldMerge =
    FIELD_MERGE_KINDS.has(remote.kind) &&
    base !== undefined &&
    !base.deleted &&
    !local.deleted &&
    !remote.deleted &&
    base.kind === local.kind &&
    local.kind === remote.kind;

  if (!canFieldMerge) {
    return order > 0
      ? { action: 'keep-local', record: local }
      : { action: 'take-remote', record: remote };
  }

  const localWins = order > 0;
  // Copies: the records passed in stay as they are.
  const [bd, ld, rd] = [base.data, local.data, remote.data].map((d) => ({
    ...(d as Record<string, unknown>),
  })) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  // Reminders merge per person even when the plan had none yet (one side
  // adds mine while the other adds theirs).
  if (remote.kind === 'event' && (bd.remind || ld.remind || rd.remind)) {
    const none = { a: null, b: null };
    for (const x of [bd, ld, rd]) if (!x.remind) x.remind = none;
  }
  const merged = mergeFields(bd, ld, rd, localWins, 1);
  const had = (d: unknown) => !!(d as { remind?: unknown }).remind;
  if (sameJson(merged.remind, { a: null, b: null }) && !had(local.data) && !had(remote.data))
    delete merged.remind;
  const units = UNITS[remote.kind];
  if (units) {
    const whenFrom = mergeUnits(merged, bd, ld, rd, units, localWins);
    // Skipped days are named by their time: after a change of time or
    // repeat they follow that change whole; otherwise they merge by day.
    if (whenFrom) {
      const kept = exceptAfterMove(bd, ld, rd, whenFrom, localWins);
      if (kept === undefined) delete merged.except;
      else merged.except = kept;
    } else if (!sameJson(ld.except, bd.except) && !sameJson(rd.except, bd.except)) {
      // Only when both sides changed them; otherwise mergeFields took the one that did.
      merged.except = mergeExcept(bd.except, ld.except, rd.except, localWins);
    }
  }
  // A merge must still be a valid record; otherwise fall back to LWW.
  if (!isValidData(remote.kind, merged)) {
    return localWins
      ? { action: 'keep-local', record: local }
      : { action: 'take-remote', record: remote };
  }
  if (sameJson(merged, remote.data)) return { action: 'take-remote', record: remote };
  if (sameJson(merged, local.data)) return { action: 'keep-local', record: local };
  const record = {
    kind: remote.kind,
    deleted: false,
    data: merged,
    updated_at: nextTimestamp(writer.now, Math.max(local.updated_at, remote.updated_at)),
    device_id: writer.device_id,
  } as DecodedRecord;
  return { action: 'merged', record };
}
