// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isUuid, uuidv7, uuidv7Time } from './ids';

describe('uuidv7', () => {
  it('is a valid v7 UUID carrying the timestamp', () => {
    const now = 1_762_144_000_123;
    const id = uuidv7(now);
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
    expect(uuidv7Time(id)).toBe(now);
  });

  it('sorts by creation time', () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    expect(a < b).toBe(true);
  });

  it('is unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(5)));
    expect(ids.size).toBe(1000);
  });

  it('rejects non-UUIDs', () => {
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid('0190A6C8-7A3E-7CC2-9B1D-3F6E2A1B4C5D')).toBe(false);
  });
});
