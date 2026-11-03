// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Typed sealing and opening of records: schema validation + scope policy +
 * envelope encryption in one place, so private content cannot be sealed
 * under the shared space key by an app bug.
 */

import { type DecodedRecord, decodeRecord, encodeRecord } from '../schema/records';
import type { Sealed } from './aead';
import { CryptoError } from './bytes';
import { openRecord, type RecordHeader, type Scope, sealRecord } from './envelope';
import type { KeyRing } from './keys';

/**
 * Which scopes a record may live in.
 * - Busy-only events and private lists: personal key only (scope 'user').
 * - Busy stubs exist so the partner can see them: space key only.
 * - Tombstones carry no content and may be in either scope.
 */
export function scopeAllows(record: DecodedRecord, scope: Scope): boolean {
  if (record.deleted) return true;
  switch (record.kind) {
    case 'event':
      return record.data.privacy === 'busy' ? scope === 'user' : true;
    case 'list':
      return record.data.private ? scope === 'user' : true;
    case 'busy_stub':
      return scope === 'space';
    default:
      return true;
  }
}

export function sealDecodedRecord(
  ring: KeyRing,
  target: { id: string; space_id: string; scope: Scope },
  record: DecodedRecord,
): { header: RecordHeader } & Sealed {
  if (!scopeAllows(record, target.scope)) {
    throw new CryptoError('format', 'Record content not allowed in this scope');
  }
  return sealRecord(ring, { ...target, deleted: record.deleted }, encodeRecord(record));
}

export type OpenResult =
  | { ok: true; record: DecodedRecord }
  | { ok: false; reason: 'newer-schema' | 'invalid' | 'scope' };

/** Decrypts and decodes. Throws CryptoError if decryption fails. */
export function openDecodedRecord(ring: KeyRing, header: RecordHeader, sealed: Sealed): OpenResult {
  const result = decodeRecord(openRecord(ring, header, sealed));
  if (!result.ok) return result;
  if (result.record.deleted !== header.deleted) return { ok: false, reason: 'invalid' };
  if (!scopeAllows(result.record, header.scope)) return { ok: false, reason: 'scope' };
  return result;
}
