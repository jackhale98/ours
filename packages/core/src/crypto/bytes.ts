// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Byte helpers used by the crypto module. Kept separate so the encoding
 * rules (base64url without padding, UTF-8) are defined in exactly one place.
 */
import { randomBytes as nobleRandomBytes } from '@noble/ciphers/utils.js';

export { concatBytes, equalBytes } from '@noble/ciphers/utils.js';

/** Cryptographically secure random bytes (WebCrypto getRandomValues). */
export function randomBytes(length: number): Uint8Array {
  return nobleRandomBytes(length);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP = new Map<string, number>([...B64URL].map((c, i) => [c, i]));

/** RFC 4648 base64url, no padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += B64URL.charAt((n >> (18 - 6 * c)) & 63);
  }
  return out;
}

/** Strict base64url decoder: rejects padding, invalid characters and non-canonical trailing bits. */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new CryptoError('encoding', 'Invalid base64url length');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of text) {
    const v = B64URL_LOOKUP.get(ch);
    if (v === undefined) throw new CryptoError('encoding', 'Invalid base64url character');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) {
    throw new CryptoError('encoding', 'Non-canonical base64url');
  }
  return out;
}

export type CryptoErrorCode =
  | 'encoding'
  | 'decrypt'
  | 'key'
  | 'format'
  | 'phrase'
  | 'invite'
  | 'unknown-key-version';

/**
 * All failures from this module are CryptoErrors with a coarse code.
 * Messages never include key material or plaintext.
 */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}
