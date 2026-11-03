// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recovery phrase and key backups.
 *
 * The recovery phrase encodes 128 bits of entropy as 12 BIP39 English words.
 * We do not use the BIP39 seed (PBKDF2) step: the entropy is already uniform,
 * so the recovery key is HKDF(entropy, "ours/recovery/v1").
 *
 * The server stores Enc(recovery key, key ring) with AAD
 * (label | user_id | backup_version).
 */
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { buildAad } from './aad';
import { open, type Sealed, seal } from './aead';
import { parseKeyRing, serializeKeyRing } from './bundle';
import { CryptoError, randomBytes } from './bytes';
import { deriveKey, LABELS } from './kdf';
import { assertVersion, type KeyRing } from './keys';

export const PHRASE_WORDS = 12;
const ENTROPY_BYTES = 16;

export function generateRecoveryPhrase(): string[] {
  return entropyToMnemonic(randomBytes(ENTROPY_BYTES), wordlist).split(' ');
}

/**
 * Normalises user input: case, whitespace, and unambiguous 4+ letter
 * prefixes (every BIP39 English word is unique in its first four letters).
 * Returns null for any word that cannot be resolved.
 */
export function normalizePhrase(input: string): (string | null)[] {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(resolveWord);
}

export function resolveWord(raw: string): string | null {
  const word = raw.normalize('NFKD').toLowerCase().trim();
  if (wordlist.includes(word)) return word;
  if (word.length < 4) return null;
  const matches = wordlist.filter((w) => w.startsWith(word));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function isValidPhrase(words: readonly (string | null)[]): words is string[] {
  if (words.length !== PHRASE_WORDS || words.some((w) => w === null)) return false;
  return validateMnemonic(words.join(' '), wordlist);
}

/** Derives the 32-byte recovery key. Throws CryptoError('phrase') if the phrase is invalid. */
export function recoveryKeyFromPhrase(words: readonly (string | null)[]): Uint8Array {
  if (!isValidPhrase(words)) throw new CryptoError('phrase', 'Invalid recovery phrase');
  return deriveKey(mnemonicToEntropy(words.join(' '), wordlist), LABELS.recovery);
}

/** Chooses `count` distinct word positions to ask the user to type back. */
export function pickConfirmationIndices(count = 2, total = PHRASE_WORDS): number[] {
  if (count > total) throw new RangeError('count exceeds total');
  const picked = new Set<number>();
  while (picked.size < count) picked.add(uniformInt(total));
  return [...picked].sort((a, b) => a - b);
}

export function checkConfirmation(
  words: readonly string[],
  answers: readonly { index: number; word: string }[],
): boolean {
  return (
    answers.length > 0 &&
    answers.every(({ index, word }) => {
      const expected = words[index];
      return expected !== undefined && resolveWord(word) === expected;
    })
  );
}

/** Uniform integer in [0, n) by rejection sampling. */
function uniformInt(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new RangeError('n out of range');
  const limit = 256 - (256 % n);
  for (;;) {
    const b = randomBytes(1)[0] ?? 255;
    if (b < limit) return b % n;
  }
}

function backupAad(userId: string, version: number): Uint8Array {
  if (!userId) throw new CryptoError('format', 'Missing user id');
  assertVersion(version);
  return buildAad([LABELS.backup, userId, version]);
}

export function sealBackup(recoveryKey: Uint8Array, ring: KeyRing, version: number): Sealed {
  return seal(recoveryKey, serializeKeyRing(ring), backupAad(ring.userId, version));
}

export function openBackup(
  recoveryKey: Uint8Array,
  userId: string,
  version: number,
  sealed: Sealed,
): KeyRing {
  const ring = parseKeyRing(
    open(recoveryKey, sealed.nonce, sealed.ciphertext, backupAad(userId, version)),
  );
  if (ring.userId !== userId) throw new CryptoError('format', 'Backup user mismatch');
  return ring;
}
