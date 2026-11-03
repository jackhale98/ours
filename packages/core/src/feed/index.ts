// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Busy blocks for a user's calendar feed (the opt-in .ics link they can add
 * to Google/Apple Calendar). Computed on device; only the resulting time
 * blocks are uploaded, never titles.
 *
 * Rules:
 * - Only plans that involve the user (theirs or "ours"), plus the partner's
 *   if they opted in. Transparent ("free") imported events are skipped.
 * - Calendars the user imported themselves, or that belong to them, are left
 *   out: they already have those in their calendar app, so including them
 *   would show every event twice.
 * - Tentative plans count as busy unless turned off.
 */
import { type Interval, mergeIntervals } from '../time/free';

export type Slot = 'a' | 'b';
export type Owner = Slot | 'both';

export type FeedSource =
  | { kind: 'plan'; owner: Owner; tentative: boolean }
  | { kind: 'import'; owner: Owner; importer: Slot; calendarId: string };

export interface FeedOccurrence extends Interval {
  source: FeedSource;
  /** false for events marked free/transparent in their source calendar. */
  busy: boolean;
}

export interface FeedOptions {
  /** Include the partner's busy time too (default false). */
  includePartner?: boolean;
  /** Count tentative (proposed) plans as busy (default true). */
  includeTentative?: boolean;
}

const otherSlot = (s: Slot): Slot => (s === 'a' ? 'b' : 'a');

/** Whether one occurrence belongs in `user`'s feed. */
export function inFeed(o: FeedOccurrence, user: Slot, opts: FeedOptions = {}): boolean {
  if (!o.busy || o.end <= o.start) return false;
  const owner = o.source.owner;
  const involvesUser = owner === user || owner === 'both';
  const partnerOnly = owner === otherSlot(user);
  if (!involvesUser && !(partnerOnly && opts.includePartner)) return false;
  if (o.source.kind === 'import') {
    // Already in this user's own calendar app: avoid duplicates.
    if (o.source.importer === user || owner === user) return false;
  } else if (o.source.tentative && opts.includeTentative === false) {
    return false;
  }
  return true;
}

/** Merged busy blocks for `user`, clipped to [from, to). */
export function feedBlocks(
  occurrences: readonly FeedOccurrence[],
  user: Slot,
  from: number,
  to: number,
  opts: FeedOptions = {},
): Interval[] {
  return mergeIntervals(
    occurrences
      .filter((o) => inFeed(o, user, opts))
      .map((o) => ({ start: Math.max(o.start, from), end: Math.min(o.end, to) }))
      .filter((i) => i.end > i.start),
  );
}
