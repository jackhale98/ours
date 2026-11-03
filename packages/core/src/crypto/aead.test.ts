// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { buildAad } from './aad';
import { NONCE_LENGTH, open, PAD_BLOCK, pad, seal, TAG_LENGTH, unpad } from './aead';
import { CryptoError, randomBytes, utf8 } from './bytes';
import { generateKey } from './keys';

const aad = buildAad(['test', 'context']);

describe('padding', () => {
  it.each([0, 1, 62, 63, 64, 65, 127, 128, 1000])('pads %i bytes to a block boundary', (n) => {
    const data = randomBytes(n);
    const padded = pad(data);
    expect(padded.length % PAD_BLOCK).toBe(0);
    expect(padded.length).toBeGreaterThan(n);
    expect(unpad(padded)).toEqual(data);
  });

  it('keeps trailing zero bytes of the original data', () => {
    const data = new Uint8Array([1, 0, 0, 0x80, 0]);
    expect(unpad(pad(data))).toEqual(data);
  });

  it('rejects missing padding marker', () => {
    expect(() => unpad(new Uint8Array(64))).toThrow(CryptoError);
    expect(() => unpad(new Uint8Array([1, 2, 3]))).toThrow(CryptoError);
  });
});

describe('seal/open', () => {
  it('round-trips', () => {
    const key = generateKey();
    const msg = utf8('dinner at eight');
    const s = seal(key, msg, aad);
    expect(s.nonce).toHaveLength(NONCE_LENGTH);
    expect(s.ciphertext.length).toBe(PAD_BLOCK + TAG_LENGTH);
    expect(open(key, s.nonce, s.ciphertext, aad)).toEqual(msg);
  });

  it('uses a fresh nonce every time', () => {
    const key = generateKey();
    const a = seal(key, utf8('x'), aad);
    const b = seal(key, utf8('x'), aad);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('hides length within a pad block', () => {
    const key = generateKey();
    expect(seal(key, utf8('a'), aad).ciphertext.length).toBe(
      seal(key, utf8('a'.repeat(60)), aad).ciphertext.length,
    );
  });

  it('fails with the wrong key', () => {
    const s = seal(generateKey(), utf8('secret'), aad);
    expect(() => open(generateKey(), s.nonce, s.ciphertext, aad)).toThrow(
      expect.objectContaining({ code: 'decrypt' }),
    );
  });

  it('fails with the wrong AAD', () => {
    const key = generateKey();
    const s = seal(key, utf8('secret'), aad);
    expect(() => open(key, s.nonce, s.ciphertext, buildAad(['test', 'other']))).toThrow(
      CryptoError,
    );
  });

  it('fails when any ciphertext byte is flipped', () => {
    const key = generateKey();
    const s = seal(key, utf8('secret'), aad);
    for (let i = 0; i < s.ciphertext.length; i++) {
      const tampered = s.ciphertext.slice();
      tampered[i] = (tampered[i] ?? 0) ^ 0x01;
      expect(() => open(key, s.nonce, tampered, aad)).toThrow(CryptoError);
    }
  });

  it('fails when the nonce is changed', () => {
    const key = generateKey();
    const s = seal(key, utf8('secret'), aad);
    const nonce = s.nonce.slice();
    nonce[0] = (nonce[0] ?? 0) ^ 0xff;
    expect(() => open(key, nonce, s.ciphertext, aad)).toThrow(CryptoError);
  });

  it('fails when the ciphertext is truncated or extended', () => {
    const key = generateKey();
    const s = seal(key, utf8('secret'), aad);
    expect(() => open(key, s.nonce, s.ciphertext.subarray(0, -1), aad)).toThrow(CryptoError);
    const longer = new Uint8Array(s.ciphertext.length + 1);
    longer.set(s.ciphertext);
    expect(() => open(key, s.nonce, longer, aad)).toThrow(CryptoError);
  });

  it('validates key and nonce sizes', () => {
    expect(() => seal(new Uint8Array(16), utf8('x'), aad)).toThrow(
      expect.objectContaining({ code: 'key' }),
    );
    const key = generateKey();
    const s = seal(key, utf8('x'), aad);
    expect(() => open(key, s.nonce.subarray(0, 12), s.ciphertext, aad)).toThrow(
      expect.objectContaining({ code: 'format' }),
    );
    expect(() => open(key, s.nonce, new Uint8Array(10), aad)).toThrow(
      expect.objectContaining({ code: 'format' }),
    );
  });
});

describe('buildAad', () => {
  it('is injective across field boundaries', () => {
    expect(buildAad(['ab', 'c'])).not.toEqual(buildAad(['a', 'bc']));
    expect(buildAad(['a|b'])).not.toEqual(buildAad(['a', 'b']));
    expect(buildAad([''])).not.toEqual(buildAad([]));
  });

  it('distinguishes numbers', () => {
    expect(buildAad([1])).not.toEqual(buildAad([2]));
    expect(buildAad([1])).toEqual(buildAad(['1']));
  });

  it('rejects unsafe numbers', () => {
    expect(() => buildAad([-1])).toThrow(CryptoError);
    expect(() => buildAad([1.5])).toThrow(CryptoError);
  });
});
