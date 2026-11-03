// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Encrypted export files (phase 6).
 *
 * An export is everything the person can see, decrypted on their device and
 * re-encrypted for a file they keep. The file key comes from their recovery
 * phrase (export key = HKDF(recovery key, "ours/export/v1"), separate from
 * the key that seals the server-side backup), so no new secret is needed and
 * the file is as strong as the phrase. The device never stores the phrase,
 * so exporting and importing both ask for it.
 *
 * File: {"format":"ours-export-encrypted","v":1,"nonce","ciphertext"}
 * (base64url), AAD = label | v. The plaintext is the readable export JSON.
 */
import { buildAad } from './aad';
import { open, seal } from './aead';
import { CryptoError, fromBase64Url, fromUtf8, toBase64Url, utf8 } from './bytes';
import { deriveKey, LABELS } from './kdf';
import { recoveryKeyFromPhrase } from './recovery';

export const EXPORT_FORMAT = 'ours-export-encrypted';
const VERSION = 1;

export interface EncryptedExport {
  format: typeof EXPORT_FORMAT;
  v: 1;
  nonce: string;
  ciphertext: string;
}

const aad = () => buildAad([LABELS.export, VERSION]);
const exportKey = (words: readonly (string | null)[]) =>
  deriveKey(recoveryKeyFromPhrase(words), LABELS.export);

/** Encrypts export JSON text. Throws CryptoError('phrase') for an invalid phrase. */
export function sealExport(words: readonly (string | null)[], json: string): EncryptedExport {
  const s = seal(exportKey(words), utf8(json), aad());
  return {
    format: EXPORT_FORMAT,
    v: VERSION,
    nonce: toBase64Url(s.nonce),
    ciphertext: toBase64Url(s.ciphertext),
  };
}

export function isEncryptedExport(value: unknown): value is EncryptedExport {
  const v = value as Partial<EncryptedExport> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.format === EXPORT_FORMAT &&
    v.v === VERSION &&
    typeof v.nonce === 'string' &&
    typeof v.ciphertext === 'string'
  );
}

/**
 * Decrypts an export file back to its JSON text. Throws CryptoError: 'phrase'
 * for an invalid phrase, 'decrypt' if it is the wrong phrase or the file was changed.
 */
export function openExport(words: readonly (string | null)[], file: EncryptedExport): string {
  if (!isEncryptedExport(file)) throw new CryptoError('format', 'Not an Ours export');
  return fromUtf8(
    open(exportKey(words), fromBase64Url(file.nonce), fromBase64Url(file.ciphertext), aad()),
  );
}
