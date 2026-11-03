// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isSortKey, keyBetween, keysBetween } from './sortkey';

describe('fractional sort keys', () => {
  it('creates keys in an empty list', () => {
    const k = keyBetween(null, null);
    expect(isSortKey(k)).toBe(true);
  });

  it('appends and prepends in order', () => {
    const keys = [keyBetween(null, null)];
    for (let i = 0; i < 200; i++) keys.push(keyBetween(keys[keys.length - 1] ?? null, null));
    for (let i = 0; i < 200; i++) keys.unshift(keyBetween(null, keys[0] ?? null));
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(isSortKey)).toBe(true);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(60);
  });

  it('inserts between random neighbours (property)', () => {
    const keys: string[] = [keyBetween(null, null)];
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(rand() * (keys.length + 1));
      const k = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      expect(k > (keys[at - 1] ?? '')).toBe(true);
      if (keys[at] !== undefined) expect(k < (keys[at] ?? '')).toBe(true);
      expect(isSortKey(k)).toBe(true);
      keys.splice(at, 0, k);
    }
    expect([...keys].sort()).toEqual(keys);
  });

  it('handles adjacent digits and prefixes', () => {
    expect(keyBetween('1', '2') > '1').toBe(true);
    expect(keyBetween('1', '2') < '2').toBe(true);
    expect(keyBetween('1', '11')).toMatch(/^10/);
    expect(keyBetween(null, '1') < '1').toBe(true);
    expect(keyBetween('zz', null) > 'zz').toBe(true);
    expect(keyBetween('V', 'W1') < 'W1').toBe(true);
  });

  it('produces many keys at once', () => {
    const keys = keysBetween('A', 'B', 10);
    expect(keys).toHaveLength(10);
    expect([...keys].sort()).toEqual(keys);
    expect(keys.every((k) => k > 'A' && k < 'B')).toBe(true);
    expect(keysBetween(null, null, 0)).toEqual([]);
  });

  it('rejects invalid input', () => {
    expect(() => keyBetween('B', 'A')).toThrow(RangeError);
    expect(() => keyBetween('A', 'A')).toThrow(RangeError);
    expect(() => keyBetween('A0', null)).toThrow(RangeError);
    expect(() => keyBetween(null, 'a-b')).toThrow(RangeError);
    expect(isSortKey('')).toBe(false);
    expect(isSortKey(3)).toBe(false);
  });
});
