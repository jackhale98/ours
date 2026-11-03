// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CryptoError, fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8 } from './bytes';

describe('base64url', () => {
  it.each([
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes RFC 4648 vector %j', (input, expected) => {
    expect(toBase64Url(utf8(input))).toBe(expected);
    expect(fromUtf8(fromBase64Url(expected))).toBe(input);
  });

  it('uses the URL-safe alphabet', () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_');
    expect(fromBase64Url('-_-_')).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
  });

  it('round-trips random data of every length up to 70', () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = randomBytes(n);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it.each(['Zg==', 'Z', 'Zm9v!', 'Zm9+', 'Zm9/', 'Zh', 'Zm9'.replace('9', '+')])(
    'rejects invalid or non-canonical input %j',
    (bad) => {
      expect(() => fromBase64Url(bad)).toThrow(CryptoError);
    },
  );
});

describe('utf8', () => {
  it('round-trips non-ASCII text', () => {
    const text = 'Café 🍝 — 日本';
    expect(fromUtf8(utf8(text))).toBe(text);
  });

  it('rejects invalid UTF-8', () => {
    expect(() => fromUtf8(new Uint8Array([0xc3, 0x28]))).toThrow();
  });
});

describe('randomBytes', () => {
  it('returns distinct values', () => {
    expect(randomBytes(32)).not.toEqual(randomBytes(32));
    expect(randomBytes(7)).toHaveLength(7);
  });
});
