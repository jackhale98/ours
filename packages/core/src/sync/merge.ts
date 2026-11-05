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
import { type DecodedRecord, isValidData, type Kind } from '../schema/records';
import { compareWrites, nextTimestamp } from './clock';

export const FIELD_MERGE_KINDS: ReadonlySet<Kind> = new Set<Kind>(['item', 'list', 'settings']);

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
  const merged = mergeFields(
    base.data as Record<string, unknown>,
    local.data as Record<string, unknown>,
    remote.data as Record<string, unknown>,
    localWins,
    1,
  );
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
