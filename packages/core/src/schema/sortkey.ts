// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fractional indexing for list order (after David Greenspan,
 * "Implementing Fractional Indexing"). Keys are base-62 fractions in (0, 1),
 * written without the leading "0." and never ending in the zero digit.
 * Plain string comparison orders them, so any device can insert between two
 * items without renumbering the list.
 */
export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const ZERO = DIGITS.charAt(0);

export function isSortKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 200 &&
    !key.endsWith(ZERO) &&
    [...key].every((c) => DIGITS.includes(c))
  );
}

function digit(c: string | undefined): number {
  return c === undefined ? 0 : DIGITS.indexOf(c);
}

/** Midpoint of a and b (b === null means 1). Requires a < b. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a.charAt(n) || ZERO) === b.charAt(n)) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digit(a.charAt(0)) : 0;
  const db = b !== null ? digit(b.charAt(0)) : BASE;
  if (db - da > 1) return DIGITS.charAt(Math.round((da + db) / 2));
  if (b !== null && b.length > 1) return b.charAt(0);
  return DIGITS.charAt(da) + midpoint(a.slice(1), null);
}

/**
 * Returns a key strictly between `before` and `after` (either may be null
 * for the start or end of the list).
 */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && !isSortKey(before)) throw new RangeError('Invalid sort key');
  if (after !== null && !isSortKey(after)) throw new RangeError('Invalid sort key');
  if (before !== null && after !== null && before >= after) {
    throw new RangeError('before must sort before after');
  }
  return midpoint(before ?? '', after);
}

/** `n` evenly spread keys between `before` and `after`. */
export function keysBetween(before: string | null, after: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(before, after)];
  const mid = keyBetween(before, after);
  const left = Math.floor((n - 1) / 2);
  return [...keysBetween(before, mid, left), mid, ...keysBetween(mid, after, n - 1 - left)];
}
