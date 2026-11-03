// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Record envelope encryption.
 *
 * The associated data binds each ciphertext to where it lives:
 *   label | space_id | record_id | scope | owner_user_id | key_version
 * so the server cannot move a ciphertext to another record, space, scope,
 * owner or key version without decryption failing.
 *
 * The record's kind, schema version, timestamps and content live inside the
 * ciphertext (see schema/record.ts).
 */
import { buildAad } from './aad';
import { open, type Sealed, seal } from './aead';
import { CryptoError } from './bytes';
import { LABELS } from './kdf';
import { assertVersion, type KeyRing } from './keys';

export type Scope = 'space' | 'user';

export interface RecordHeader {
  id: string;
  space_id: string;
  scope: Scope;
  /** Required for scope 'user', must be null for scope 'space'. */
  owner_user_id: string | null;
  key_version: number;
}

function assertNonEmpty(value: unknown, what: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new CryptoError('format', `Invalid ${what}`);
  }
}

export function recordAad(header: RecordHeader): Uint8Array {
  assertNonEmpty(header.id, 'record id');
  assertNonEmpty(header.space_id, 'space id');
  assertVersion(header.key_version);
  if (header.scope === 'space') {
    if (header.owner_user_id !== null) {
      throw new CryptoError('format', 'Space records have no owner');
    }
  } else if (header.scope === 'user') {
    assertNonEmpty(header.owner_user_id, 'owner user id');
  } else {
    throw new CryptoError('format', 'Invalid scope');
  }
  return buildAad([
    LABELS.record,
    header.space_id,
    header.id,
    header.scope,
    header.owner_user_id ?? '',
    header.key_version,
  ]);
}

/** Selects the key a header refers to. Throws if this device does not hold it. */
export function keyForHeader(ring: KeyRing, header: RecordHeader): Uint8Array {
  if (header.scope === 'user') {
    if (header.owner_user_id !== ring.userId) {
      throw new CryptoError('key', 'Record belongs to another user');
    }
    return ring.personalKey(header.key_version);
  }
  return ring.spaceKey(header.space_id, header.key_version);
}

export function encryptRecord(
  key: Uint8Array,
  header: RecordHeader,
  plaintext: Uint8Array,
): Sealed {
  return seal(key, plaintext, recordAad(header));
}

export function decryptRecord(key: Uint8Array, header: RecordHeader, sealed: Sealed): Uint8Array {
  return open(key, sealed.nonce, sealed.ciphertext, recordAad(header));
}

/**
 * Builds a header with the current key version for the given scope and
 * encrypts. Use this for all new writes.
 */
export function sealRecord(
  ring: KeyRing,
  target: { id: string; space_id: string; scope: Scope },
  plaintext: Uint8Array,
): { header: RecordHeader } & Sealed {
  const header: RecordHeader =
    target.scope === 'user'
      ? {
          ...target,
          owner_user_id: ring.userId,
          key_version: ring.currentPersonalKey().version,
        }
      : {
          ...target,
          owner_user_id: null,
          key_version: ring.currentSpaceKey(target.space_id).version,
        };
  const sealed = encryptRecord(keyForHeader(ring, header), header, plaintext);
  return { header, ...sealed };
}

export function openRecord(ring: KeyRing, header: RecordHeader, sealed: Sealed): Uint8Array {
  return decryptRecord(keyForHeader(ring, header), header, sealed);
}
