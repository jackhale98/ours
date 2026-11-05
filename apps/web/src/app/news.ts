// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the partner changed since this device last looked: shown when the
 * app opens, so a notification that could only say "Something changed"
 * (or none at all) still leads to what it was. Worked out on the device from
 * the synced records; the "last looked" time stays on this device.
 */
import { computed, signal } from '@preact/signals';
import { allLists, itemsOf } from './lists';
import { byKind, type Entry, findEntry, other, viewer } from './model';
import { type Hit, nextTime } from './search';
import { changeText, now } from './select';

const KEY = 'ours-seen-at';

function load(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (Number.isFinite(v) && v > 0) return v;
    // First time on this device: start from now, not from everything.
    const t = Date.now();
    localStorage.setItem(KEY, String(t));
    return t;
  } catch {
    return Date.now();
  }
}

export const seenAt = signal<number>(load());

/** "Got it": what's shown now counts as seen. */
export function markSeen(): void {
  const t = Date.now();
  seenAt.value = t;
  try {
    localStorage.setItem(KEY, String(t));
  } catch {
    // Private mode: asked again next time.
  }
}

const byPartner = (e: Entry, since: number) =>
  e.by === other(viewer.value) && e.rec.updated_at > since;

/** The partner's changes since this device last looked, newest first. */
export const news = computed((): Hit[] => {
  const since = seenAt.value;
  const at = now.value;
  const found: { at: number; hit: Hit }[] = [];
  for (const e of byKind('event')) {
    if (e.rec.kind !== 'event' || !byPartner(e, since)) continue;
    const d = e.rec.data;
    const t = nextTime(e, at);
    found.push({
      at: e.rec.updated_at,
      hit: {
        kind: 'plan',
        id: e.id,
        title: d.title,
        when: t.when,
        occ: t.occ,
        where: d.location,
        upcoming: t.up,
        repeats: !!d.rrule,
        // What they changed, when it's known: "Fri 7:30 PM → Sat 7 PM" (P-4).
        ...(d.was && d.was.by !== viewer.value && changeText(d)
          ? { change: changeText(d) as string }
          : {}),
      },
    });
  }
  for (const c of byKind('comment')) {
    if (c.rec.kind !== 'comment' || !byPartner(c, since)) continue;
    const parent = findEntry(c.rec.data.parent_id);
    if (parent?.rec.kind !== 'event') continue;
    found.push({
      at: c.rec.updated_at,
      hit: {
        kind: 'note',
        id: c.id,
        planId: parent.id,
        planTitle: parent.rec.data.title,
        text: c.rec.data.text,
      },
    });
  }
  for (const list of allLists()) {
    if (byPartner(list, since))
      found.push({ at: list.rec.updated_at, hit: { kind: 'list', id: list.id, list } });
    for (const item of itemsOf(list.id))
      if (byPartner(item, since))
        found.push({ at: item.rec.updated_at, hit: { kind: 'item', id: item.id, item, list } });
  }
  return found.sort((a, b) => b.at - a.at).map((f) => f.hit);
});
