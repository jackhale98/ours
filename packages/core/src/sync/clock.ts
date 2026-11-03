// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Write timestamps for last-writer-wins.
 *
 * A new write to a record is stamped max(now, previous + 1), where
 * `previous` is the newest timestamp this device has seen for the record.
 * So an edit made after seeing another device's version always wins over
 * it, even if this device's clock is behind.
 */
export function nextTimestamp(now: number, previous: number | undefined): number {
  const t = Math.floor(now);
  return previous === undefined ? t : Math.max(t, previous + 1);
}

/** Total order on writes: timestamp, then device id. */
export function compareWrites(
  a: { updated_at: number; device_id: string },
  b: { updated_at: number; device_id: string },
): number {
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? -1 : 1;
  if (a.device_id === b.device_id) return 0;
  return a.device_id < b.device_id ? -1 : 1;
}
