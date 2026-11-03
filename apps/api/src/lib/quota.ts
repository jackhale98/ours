// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Storage accounting. Each record is charged its ciphertext and nonce plus a
 * fixed overhead for the row, index and metadata, so many tiny records can't
 * dodge the per-space quota.
 */
export const ROW_OVERHEAD = 256;
export const recordCost = (nonceBytes: number, ciphertextBytes: number) =>
  nonceBytes + ciphertextBytes + ROW_OVERHEAD;

/** SQL expression: the charged size of all records in a space (bind the space id). */
export const SPACE_BYTES_SQL = `(SELECT COALESCE(SUM(length(ciphertext) + length(nonce) + ${ROW_OVERHEAD}), 0) FROM records WHERE space_id = ?)`;

export const isQuotaAbort = (err: unknown) =>
  String((err as Error)?.message ?? err).includes('quota_guard');
