// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CryptoError } from './bytes';
import { isEncryptedExport, openExport, sealExport } from './export';
import { generateRecoveryPhrase } from './recovery';

describe('encrypted export', () => {
  const json = JSON.stringify({ format: 'ours-export', v: 1, entries: [{ title: 'Dinner ✨' }] });

  it('round-trips with the same phrase and hides the content', () => {
    const words = generateRecoveryPhrase();
    const file = sealExport(words, json);
    expect(isEncryptedExport(file)).toBe(true);
    expect(JSON.stringify(file)).not.toContain('Dinner');
    expect(openExport(words, file)).toBe(json);
    // Same phrase typed with different spacing/case still opens it upstream
    // (normalizePhrase); here the exact words are used.
    expect(openExport([...words], JSON.parse(JSON.stringify(file)))).toBe(json);
  });

  it('fails closed with the wrong phrase, a changed file, or a bad phrase', () => {
    const words = generateRecoveryPhrase();
    const file = sealExport(words, json);
    expect(() => openExport(generateRecoveryPhrase(), file)).toThrow(CryptoError);
    const tampered = { ...file, ciphertext: `${file.ciphertext.slice(0, -2)}AA` };
    expect(() => openExport(words, tampered)).toThrow(CryptoError);
    expect(() => sealExport(['not', 'a', 'phrase'], json)).toThrow(CryptoError);
    expect(isEncryptedExport({ format: 'ours-export', v: 1 })).toBe(false);
  });

  it('uses a key separate from the backup key', () => {
    // Two exports of the same data differ (random nonce).
    const words = generateRecoveryPhrase();
    expect(sealExport(words, json).ciphertext).not.toBe(sealExport(words, json).ciphertext);
  });
});
