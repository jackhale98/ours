// SPDX-License-Identifier: AGPL-3.0-or-later
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from './bytes';

/**
 * Domain-separation labels. Every derived key and every AAD starts with one
 * of these, so material from one purpose can never be accepted for another.
 * Changing a label is a breaking protocol change.
 */
export const LABELS = {
  invite: 'ours/invite/v1',
  recovery: 'ours/recovery/v1',
  backup: 'ours/backup/v1',
  record: 'ours/record/v1',
  notify: 'ours/notify/v1',
  safety: 'ours/safety-code/v1',
} as const;

/** HKDF-SHA256 with an empty salt; inputs are already uniformly random. */
export function deriveKey(ikm: Uint8Array, info: string, length = 32): Uint8Array {
  return hkdf(sha256, ikm, undefined, utf8(info), length);
}

export { sha256 };
