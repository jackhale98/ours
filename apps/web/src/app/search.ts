// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Search, on this device. Plans, lists and notes are end-to-end encrypted,
 * so the server can't search them; this runs over what this device has
 * already decrypted, and the words searched for never leave it.
 *
 * Every word must start a word in what's searched (in any order), ignoring
 * case and accents. Only
 * what this person may see is searched: a partner's private plans are
 * "Busy" here as everywhere, and busy-only imported calendars have no titles.
 */
import { dateIn, expand } from '@ours/core/time';
import { allLists, type ItemEntry, itemsOf, type ListEntry } from './lists';
import { byKind, type Entry, findEntry, viewer } from './model';
import { now, visibleSnapshots, zone } from './select';

export type Hit =
  | {
      kind: 'plan';
      id: string;
      title: string;
      /** Next (or last) day it happens, for opening that day. */
      when: number | null;
      occ: string | null;
      where: string | null;
      upcoming: boolean;
      repeats: boolean;
    }
  | { kind: 'note'; id: string; planId: string; planTitle: string; text: string }
  | { kind: 'item'; id: string; item: ItemEntry; list: ListEntry }
  | { kind: 'list'; id: string; list: ListEntry }
  | {
      kind: 'import';
      id: string;
      key: string;
      title: string;
      source: string | null;
      when: number;
      date: string;
    };

const MAX_PER_KIND = 50;
const YEAR = 366 * 86_400_000;

/** Lower case, accents removed: "Café" matches "cafe". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function terms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean).slice(0, 8);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every word starts a word somewhere in the fields: "din" finds "dinner", not "wedding". */
export function matches(words: string[], ...fields: (string | null | undefined)[]): boolean {
  const hay = fold(fields.filter(Boolean).join(' \u0001 '));
  return words.every((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(w)}`, 'u').test(hay));
}

/** When a plan next happens (or last happened), and that day's original start. */
function nextTime(e: Entry, at: number): { when: number | null; occ: string | null; up: boolean } {
  if (e.rec.kind !== 'event') return { when: null, occ: null, up: false };
  const d = e.rec.data;
  try {
    const ahead = expand(d, at, at + YEAR, zone)[0];
    if (ahead)
      return {
        when: ahead.start,
        occ: d.rrule ? (ahead.movedFrom ?? ahead.localStart) : null,
        up: true,
      };
    const behind = expand(d, at - YEAR, at, zone).at(-1);
    if (behind)
      return {
        when: behind.start,
        occ: d.rrule ? (behind.movedFrom ?? behind.localStart) : null,
        up: false,
      };
  } catch {
    // A plan with times this device can't place: still findable, without a date.
  }
  return { when: null, occ: null, up: false };
}

export function search(query: string): Hit[] {
  const words = terms(query);
  if (!words.length) return [];
  const at = now.value;
  const plans: Hit[] = [];
  const notes: Hit[] = [];
  for (const e of byKind('event')) {
    if (e.rec.kind !== 'event') continue;
    const d = e.rec.data;
    // A declined proposal stays only with the person who asked.
    if (d.status === 'declined' && d.proposed_by !== viewer.value) continue;
    if (matches(words, d.title, d.location, d.notes)) {
      const t = nextTime(e, at);
      plans.push({
        kind: 'plan',
        id: e.id,
        title: d.title,
        when: t.when,
        occ: t.occ,
        where: d.location,
        upcoming: t.up,
        repeats: !!d.rrule,
      });
    }
  }
  for (const c of byKind('comment')) {
    if (c.rec.kind !== 'comment' || !matches(words, c.rec.data.text)) continue;
    const parent = findEntry(c.rec.data.parent_id);
    if (parent?.rec.kind !== 'event') continue;
    notes.push({
      kind: 'note',
      id: c.id,
      planId: parent.id,
      planTitle: parent.rec.data.title,
      text: c.rec.data.text,
    });
  }
  // Coming up soonest first, then past ones, most recent first.
  plans.sort((a, b) => {
    if (a.kind !== 'plan' || b.kind !== 'plan') return 0;
    if (a.upcoming !== b.upcoming) return a.upcoming ? -1 : 1;
    const x = a.when ?? 0;
    const y = b.when ?? 0;
    return a.upcoming ? x - y : y - x;
  });

  const items: Hit[] = [];
  const lists: Hit[] = [];
  for (const list of allLists()) {
    if (matches(words, list.rec.data.name)) lists.push({ kind: 'list', id: list.id, list });
    for (const item of itemsOf(list.id)) {
      const d = item.rec.data;
      if (matches(words, [d.text, d.note ?? '', d.section ?? ''].join(' ')))
        items.push({ kind: 'item', id: item.id, item, list });
    }
  }
  // Open things before done ones.
  items.sort((a, b) =>
    a.kind === 'item' && b.kind === 'item'
      ? Number(a.item.rec.data.done) - Number(b.item.rec.data.done)
      : 0,
  );

  const imported: Hit[] = [];
  for (const snap of visibleSnapshots()) {
    const s = snap.rec.data;
    if (s.detail !== 'full') continue;
    s.items.forEach((item, i) => {
      if (!item.title || !matches(words, item.title, item.location, s.name)) return;
      try {
        const o = expand({ ...item, rrule: null }, 0, Number.MAX_SAFE_INTEGER, zone)[0];
        if (!o) return;
        imported.push({
          kind: 'import',
          id: `${snap.id}:${i}`,
          key: `${snap.id}:${i}`,
          title: item.title,
          source: s.name ?? null,
          when: o.start,
          date: item.all_day ? o.localStart.slice(0, 10) : dateIn(o.start, zone),
        });
      } catch {
        // Unplaceable times: skip.
      }
    });
  }
  imported.sort((a, b) => (a.kind === 'import' && b.kind === 'import' ? a.when - b.when : 0));

  return [
    ...plans.slice(0, MAX_PER_KIND),
    ...lists.slice(0, MAX_PER_KIND),
    ...items.slice(0, MAX_PER_KIND),
    ...notes.slice(0, MAX_PER_KIND),
    ...imported.slice(0, MAX_PER_KIND),
  ];
}
