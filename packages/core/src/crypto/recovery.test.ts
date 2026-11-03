// SPDX-License-Identifier: AGPL-3.0-or-later
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './bytes';
import { generateKey, KeyRing } from './keys';
import {
  checkConfirmation,
  generateRecoveryPhrase,
  isValidPhrase,
  normalizePhrase,
  openBackup,
  PHRASE_WORDS,
  pickConfirmationIndices,
  recoveryKeyFromPhrase,
  resolveWord,
  sealBackup,
} from './recovery';

// BIP39 test vector: 128 bits of zero entropy.
const ZERO_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('recovery phrase', () => {
  it('generates 12 valid, distinct phrases', () => {
    const a = generateRecoveryPhrase();
    const b = generateRecoveryPhrase();
    expect(a).toHaveLength(PHRASE_WORDS);
    expect(isValidPhrase(a)).toBe(true);
    expect(a).not.toEqual(b);
  });

  it('derives the same key from the same phrase', () => {
    const words = generateRecoveryPhrase();
    expect(recoveryKeyFromPhrase(words)).toEqual(recoveryKeyFromPhrase([...words]));
    expect(recoveryKeyFromPhrase(words)).toHaveLength(32);
  });

  it('matches the frozen derivation for the BIP39 zero vector', () => {
    // Freezes HKDF(entropy, "ours/recovery/v1"). Changing this breaks every existing backup.
    const key = recoveryKeyFromPhrase(ZERO_PHRASE.split(' '));
    expect(Buffer.from(key).toString('hex')).toMatchInlineSnapshot(
      `"72428c6a0af51b9d61cb653e8d521c43cebe37c74ae06e0724a4c53efb620667"`,
    );
  });

  it('normalises case, spacing, commas and prefixes', () => {
    const input =
      '  ABANDON, aban  abandon abandon abandon abandon abandon abandon abandon abandon abandon abou ';
    expect(normalizePhrase(input)).toEqual(ZERO_PHRASE.split(' '));
  });

  it('resolves only unambiguous prefixes of 4+ letters', () => {
    expect(resolveWord('zoo')).toBe('zoo');
    expect(resolveWord('aban')).toBe('abandon');
    expect(resolveWord('ab')).toBeNull();
    expect(resolveWord('xyzzy')).toBeNull();
    // Every word must be unique in its first four letters (BIP39 property).
    for (const w of wordlist) expect(resolveWord(w.slice(0, 4))).toBe(w);
  });

  it('rejects bad checksums, wrong lengths and unknown words', () => {
    const bad = ZERO_PHRASE.replace('about', 'abandon').split(' ');
    expect(isValidPhrase(bad)).toBe(false);
    expect(isValidPhrase(ZERO_PHRASE.split(' ').slice(0, 11))).toBe(false);
    expect(isValidPhrase([...ZERO_PHRASE.split(' ').slice(0, 11), null])).toBe(false);
    expect(() => recoveryKeyFromPhrase(bad)).toThrow(expect.objectContaining({ code: 'phrase' }));
  });

  it('picks distinct, sorted confirmation indices', () => {
    for (let i = 0; i < 200; i++) {
      const [a, b, ...rest] = pickConfirmationIndices(2);
      expect(rest).toEqual([]);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(PHRASE_WORDS);
      expect(a).toBeLessThan(b ?? -1);
    }
    expect(() => pickConfirmationIndices(13)).toThrow(RangeError);
    expect(() => pickConfirmationIndices(1, 300)).toThrow(RangeError);
  });

  it('covers every position over many picks', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) for (const n of pickConfirmationIndices(2)) seen.add(n);
    expect(seen.size).toBe(PHRASE_WORDS);
  });

  it('checks confirmation answers', () => {
    const words = ZERO_PHRASE.split(' ');
    expect(checkConfirmation(words, [{ index: 11, word: 'About' }])).toBe(true);
    expect(checkConfirmation(words, [{ index: 11, word: 'abandon' }])).toBe(false);
    expect(checkConfirmation(words, [{ index: 12, word: 'about' }])).toBe(false);
    expect(checkConfirmation(words, [])).toBe(false);
  });
});

describe('key backup', () => {
  function ring(): KeyRing {
    const r = new KeyRing('sam');
    r.addPersonalKey({ version: 1, key: generateKey() });
    r.addSpaceKey('s1', { version: 1, key: generateKey() });
    return r;
  }

  it('round-trips with the recovery key', () => {
    const r = ring();
    const rk = recoveryKeyFromPhrase(generateRecoveryPhrase());
    const sealed = sealBackup(rk, r, 3);
    const restored = openBackup(rk, 'sam', 3, sealed);
    expect(restored.spaceKeys('s1')).toEqual(r.spaceKeys('s1'));
    expect(restored.personalKeys()).toEqual(r.personalKeys());
  });

  it('fails with the wrong phrase', () => {
    const sealed = sealBackup(recoveryKeyFromPhrase(generateRecoveryPhrase()), ring(), 1);
    expect(() =>
      openBackup(recoveryKeyFromPhrase(generateRecoveryPhrase()), 'sam', 1, sealed),
    ).toThrow(expect.objectContaining({ code: 'decrypt' }));
  });

  it('fails if the server swaps users or lies about the version', () => {
    const rk = recoveryKeyFromPhrase(generateRecoveryPhrase());
    const sealed = sealBackup(rk, ring(), 2);
    expect(() => openBackup(rk, 'alex', 2, sealed)).toThrow(CryptoError);
    expect(() => openBackup(rk, 'sam', 1, sealed)).toThrow(CryptoError);
  });

  it('rejects invalid versions and user ids', () => {
    const rk = recoveryKeyFromPhrase(generateRecoveryPhrase());
    expect(() => sealBackup(rk, ring(), 0)).toThrow(CryptoError);
    expect(() => sealBackup(rk, new KeyRing(''), 1)).toThrow(CryptoError);
  });
});
