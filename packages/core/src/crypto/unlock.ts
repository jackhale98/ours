// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Passkey unlock (ADR 0015): a copy of the key ring sealed with a key that
 * only a passkey can produce, through the WebAuthn PRF extension.
 *
 * The passkey evaluates PRF(UNLOCK_SALT) after the person confirms with face,
 * fingerprint or device passcode. That 32-byte output never leaves the
 * device; the sealing key is HKDF(output, "ours/passkey-unlock/v1"). The
 * server stores Enc(key, ring) with AAD (label | user_id | credential_id),
 * one per passkey, and can't open it.
 */
import { buildAad } from './aad';
import { open, type Sealed, seal } from './aead';
import { parseKeyRing, serializeKeyRing } from './bundle';
import { CryptoError, utf8 } from './bytes';
import { deriveKey, LABELS, sha256 } from './kdf';
import type { KeyRing } from './keys';

/** The fixed PRF input: the same for every passkey, so any of them can be asked for it. */
export const UNLOCK_SALT: Uint8Array = sha256(utf8(LABELS.unlock));

function unlockKey(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length < 32) throw new CryptoError('key', 'Passkey output too short');
  return deriveKey(prfOutput, LABELS.unlock);
}

const unlockAad = (userId: string, credentialId: string) =>
  buildAad([LABELS.unlock, userId, credentialId]);

export function sealUnlock(prfOutput: Uint8Array, ring: KeyRing, credentialId: string): Sealed {
  const key = unlockKey(prfOutput);
  try {
    return seal(key, serializeKeyRing(ring), unlockAad(ring.userId, credentialId));
  } finally {
    key.fill(0);
  }
}

export function openUnlock(
  prfOutput: Uint8Array,
  userId: string,
  credentialId: string,
  sealed: Sealed,
): KeyRing {
  const key = unlockKey(prfOutput);
  try {
    const ring = parseKeyRing(
      open(key, sealed.nonce, sealed.ciphertext, unlockAad(userId, credentialId)),
    );
    if (ring.userId !== userId) throw new CryptoError('format', 'Unlock user mismatch');
    return ring;
  } finally {
    key.fill(0);
  }
}
