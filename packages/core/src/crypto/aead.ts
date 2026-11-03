// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin wrapper around XChaCha20-Poly1305 from @noble/ciphers.
 * Every encryption uses a fresh random 24-byte nonce. Plaintexts are padded
 * to a bucket boundary so ciphertext length reveals less about content.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { CryptoError, randomBytes } from './bytes';

export const KEY_LENGTH = 32;
export const NONCE_LENGTH = 24;
export const TAG_LENGTH = 16;

/** Pad to a multiple of this many bytes (ISO/IEC 7816-4: 0x80 then zeros). */
export const PAD_BLOCK = 64;

export interface Sealed {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_LENGTH) {
    throw new CryptoError('key', 'Key must be 32 bytes');
  }
}

export function pad(data: Uint8Array, block = PAD_BLOCK): Uint8Array {
  const padded = new Uint8Array(Math.ceil((data.length + 1) / block) * block);
  padded.set(data);
  padded[data.length] = 0x80;
  return padded;
}

export function unpad(data: Uint8Array): Uint8Array {
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0) i--;
  if (i < 0 || data[i] !== 0x80) throw new CryptoError('format', 'Invalid padding');
  return data.subarray(0, i);
}

export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Sealed {
  assertKey(key);
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(pad(plaintext));
  return { nonce, ciphertext };
}

export function open(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  assertKey(key);
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_LENGTH) {
    throw new CryptoError('format', 'Nonce must be 24 bytes');
  }
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length < TAG_LENGTH + PAD_BLOCK) {
    throw new CryptoError('format', 'Ciphertext too short');
  }
  let padded: Uint8Array;
  try {
    padded = xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    // Wrong key, wrong AAD or tampered ciphertext all look the same.
    throw new CryptoError('decrypt', 'Decryption failed');
  }
  return unpad(padded);
}
