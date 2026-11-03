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
import type { DecodedRecord, Kind } from '../schema/records';
import { compareWrites, nextTimestamp } from './clock';

export const FIELD_MERGE_KINDS: ReadonlySet<Kind> = new Set<Kind>(['item', 'settings']);

export type MergeOutcome =
  /** Remote is the result. Store it; nothing to push. */
  | { action: 'take-remote'; record: DecodedRecord }
  /** Local wins outright. Keep it and push it (with base_rev = remote rev). */
  | { action: 'keep-local'; record: DecodedRecord }
  /** A new record combining both sides. Store it and push it. */
  | { action: 'merged'; record: DecodedRecord };

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

  const b = base.data as Record<string, unknown>;
  const l = local.data as Record<string, unknown>;
  const r = remote.data as Record<string, unknown>;
  const localWins = order > 0;
  const merged: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
    const localChanged = !sameJson(l[key], b[key]);
    const remoteChanged = !sameJson(r[key], b[key]);
    let value: unknown;
    if (localChanged && remoteChanged) value = localWins ? l[key] : r[key];
    else if (localChanged) value = l[key];
    else value = r[key];
    if (value !== undefined) merged[key] = value;
  }
  if (sameJson(merged, r)) return { action: 'take-remote', record: remote };
  if (sameJson(merged, l)) return { action: 'keep-local', record: local };
  const record = {
    kind: remote.kind,
    deleted: false,
    data: merged,
    updated_at: nextTimestamp(writer.now, Math.max(local.updated_at, remote.updated_at)),
    device_id: writer.device_id,
  } as DecodedRecord;
  return { action: 'merged', record };
}
