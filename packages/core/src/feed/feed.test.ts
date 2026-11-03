// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { type FeedOccurrence, feedBlocks, inFeed } from './index';

const H = 3_600_000;
const plan = (
  owner: 'a' | 'b' | 'both',
  s: number,
  e: number,
  tentative = false,
): FeedOccurrence => ({
  start: s * H,
  end: e * H,
  busy: true,
  source: { kind: 'plan', owner, tentative },
});
const imp = (
  owner: 'a' | 'b' | 'both',
  importer: 'a' | 'b',
  s: number,
  e: number,
  busy = true,
): FeedOccurrence => ({
  start: s * H,
  end: e * H,
  busy,
  source: { kind: 'import', owner, importer, calendarId: 'c' },
});

describe('feed membership', () => {
  it.each<[string, FeedOccurrence, boolean]>([
    ['my plan', plan('a', 1, 2), true],
    ['our plan', plan('both', 1, 2), true],
    ['partner plan (default off)', plan('b', 1, 2), false],
    ['tentative plan', plan('both', 1, 2, true), true],
    ['calendar I imported myself (duplicate)', imp('a', 'a', 1, 2), false],
    ['my calendar imported by my partner (duplicate)', imp('a', 'b', 1, 2), false],
    ['shared calendar I imported (duplicate)', imp('both', 'a', 1, 2), false],
    ['shared calendar my partner imported', imp('both', 'b', 1, 2), true],
    ['partner calendar partner imported (default off)', imp('b', 'b', 1, 2), false],
    ['free/transparent event', imp('both', 'b', 1, 2, false), false],
    ['zero-length', plan('a', 1, 1), false],
  ])('%s', (_name, o, expected) => {
    expect(inFeed(o, 'a')).toBe(expected);
  });

  it('can include the partner, but still never my own imports', () => {
    expect(inFeed(plan('b', 1, 2), 'a', { includePartner: true })).toBe(true);
    expect(inFeed(imp('b', 'b', 1, 2), 'a', { includePartner: true })).toBe(true);
    expect(inFeed(imp('b', 'a', 1, 2), 'a', { includePartner: true })).toBe(false);
  });

  it('can leave out tentative plans', () => {
    expect(inFeed(plan('both', 1, 2, true), 'a', { includeTentative: false })).toBe(false);
  });
});

describe('feedBlocks', () => {
  it('merges overlaps, clips to the window and drops excluded items', () => {
    const blocks = feedBlocks(
      [plan('a', 1, 3), plan('both', 2, 4), imp('a', 'a', 5, 6), plan('a', 9, 12)],
      'a',
      0,
      10 * H,
    );
    expect(blocks).toEqual([
      { start: 1 * H, end: 4 * H },
      { start: 9 * H, end: 10 * H },
    ]);
  });

  it('is symmetric for the other person', () => {
    expect(feedBlocks([imp('a', 'a', 1, 2)], 'b', 0, 10 * H)).toEqual([]);
    expect(feedBlocks([imp('a', 'a', 1, 2)], 'b', 0, 10 * H, { includePartner: true })).toEqual([
      { start: 1 * H, end: 2 * H },
    ]);
  });
});
