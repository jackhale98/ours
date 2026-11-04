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
import { concatBytes, toBase64Url } from './bytes';
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

/**
 * Key fingerprint (review 0005, H1): binds a key version to the key behind
 * it. Sent to the server when a rotation makes the version current, so any
 * device can tell whether the key it holds for that version is the real one
 * (and not an orphan from a rotation that never happened, or a key from a
 * link it shouldn't trust). One-way: it reveals nothing about the key.
 *
 * kid = base64url(first 16 bytes of SHA-256(AAD(label, scope, owner, version) || key))
 * where owner is the space id for space keys and the user id for personal keys.
 */
export function keyId(
  scope: 'space' | 'user',
  owner: string,
  version: number,
  key: Uint8Array,
): string {
  assertKey(key);
  assertVersion(version);
  return toBase64Url(
    sha256(concatBytes(buildAad([LABELS.keyId, scope, owner, version]), key)).subarray(0, 16),
  );
}
