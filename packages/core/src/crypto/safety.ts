// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Safety code: a short fingerprint of a space key that both partners compare
 * in person after pairing. Matching codes mean both devices hold the same key,
 * which rules out a swapped or tampered invite.
 *
 * code = first 64 bits of SHA-256(AAD(label, space_id, key_version) || key) mod 10^9,
 * shown as three groups of three digits.
 */
import { buildAad } from './aad';
import { assertKey } from './aead';
import { concatBytes } from './bytes';
import { LABELS, sha256 } from './kdf';
import { assertVersion } from './keys';

export function safetyCode(spaceId: string, keyVersion: number, key: Uint8Array): string {
  assertKey(key);
  assertVersion(keyVersion);
  const digest = sha256(concatBytes(buildAad([LABELS.safety, spaceId, keyVersion]), key));
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(digest[i] ?? 0);
  const digits = (n % 1_000_000_000n).toString().padStart(9, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)}`;
}
