// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CryptoError } from './bytes';
import { generateKey } from './keys';
import { safetyCode } from './safety';

describe('safety code', () => {
  it('formats as three groups of three digits', () => {
    expect(safetyCode('s', 1, generateKey())).toMatch(/^\d{3} \d{3} \d{3}$/);
  });

  it('is deterministic and frozen', () => {
    const key = new Uint8Array(32).fill(7);
    expect(safetyCode('space', 1, key)).toBe(safetyCode('space', 1, key.slice()));
    expect(safetyCode('space', 1, key)).toMatchInlineSnapshot(`"437 494 122"`);
  });

  it('differs per key, space and version', () => {
    const key = generateKey();
    const base = safetyCode('a', 1, key);
    expect(safetyCode('a', 1, generateKey())).not.toBe(base);
    expect(safetyCode('b', 1, key)).not.toBe(base);
    expect(safetyCode('a', 2, key)).not.toBe(base);
  });

  it('rejects bad keys', () => {
    expect(() => safetyCode('a', 1, new Uint8Array(8))).toThrow(CryptoError);
    expect(() => safetyCode('a', 0, generateKey())).toThrow(CryptoError);
  });
});
