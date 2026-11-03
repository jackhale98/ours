// SPDX-License-Identifier: AGPL-3.0-or-later
/** Server-side randomness, hashing and encoding (WebCrypto only). Never touches user content keys. */

export function toB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** Opaque random token for the client (sessions, magic links, invites, feeds). 256 bits. */
export function newToken(): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Random identifier (128 bits) for rows the server creates. */
export function newId(): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Tokens are stored only as SHA-256 hashes. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toB64Url(new Uint8Array(digest));
}

export function bytesOf(
  value: ArrayBuffer | Uint8Array | null | undefined,
): Uint8Array<ArrayBuffer> {
  if (!value) return new Uint8Array();
  return value instanceof Uint8Array ? Uint8Array.from(value) : new Uint8Array(value);
}
