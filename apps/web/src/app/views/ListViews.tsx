// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Views across all lists: what's due this week, what's on me, short ideas
 * for a free evening, and what we both want. Shown on the Lists screen above
 * the lists themselves.
 */
import { IDEA_LENGTHS } from '@ours/core/schema';
import { addDays } from '@ours/core/time';
import { signal } from '@preact/signals';
import {
  allLists,
  bothWant,
  dueOf,
  featuresOf,
  type ItemEntry,
  itemsOf,
  type ListEntry,
} from '../lists';
import { viewer } from '../model';
import { today } from '../select';
import { ItemRow } from './Lists';

export type CrossView = 'due' | 'mine' | 'short' | 'both';
export const crossView = signal<CrossView | null>(null);

const VIEWS: Record<CrossView, { label: string; empty: string }> = {
  due: { label: 'Due this week', empty: 'Nothing due in the next seven days.' },
  mine: { label: 'On me', empty: 'Nothing is waiting on you.' },
  short: { label: 'Short ideas', empty: 'No ideas that take three hours or less.' },
  both: { label: 'We both want', empty: 'Nothing you’ve both hearted yet.' },
};

/** The items a view shows, with their lists, in the order to show them. */
export function viewItems(view: CrossView): { item: ItemEntry; list: ListEntry }[] {
  const out: { item: ItemEntry; list: ListEntry; key: string }[] = [];
  const t = today.value;
  const week = addDays(t, 7);
  const me = viewer.value;
  for (const list of allLists()) {
    const f = featuresOf(list);
    for (const item of itemsOf(list.id)) {
      const d = item.rec.data;
      if (f.has('tick') && d.done) continue;
      if (view === 'due') {
        const due = f.has('due') && f.has('tick') ? dueOf(item) : null;
        if (due && due <= week) out.push({ item, list, key: due });
      } else if (view === 'mine') {
        if (f.has('tick') && d.assignee === me) out.push({ item, list, key: dueOf(item) ?? '~' });
      } else if (view === 'short') {
        const fits = d.length ? IDEA_LENGTHS[d.length] <= IDEA_LENGTHS.evening : false;
        if (!f.has('tick') && f.has('plan') && fits) out.push({ item, list, key: d.text });
      } else if (f.has('hearts') && bothWant(item)) out.push({ item, list, key: d.text });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function CrossViews({ onPick }: { onPick: () => void }) {
  const v = crossView.value;
  return (
    // biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled
    <div class="chips xviews" role="group" aria-label="Across all lists">
      {(Object.keys(VIEWS) as CrossView[]).map((k) => {
        const n = viewItems(k).length;
        return (
          <button
            type="button"
            key={k}
            class="chip"
            aria-pressed={v === k}
            onClick={() => {
              crossView.value = v === k ? null : k;
              onPick();
            }}
          >
            {VIEWS[k].label}
            <span class="n"> {n}</span>
          </button>
        );
      })}
    </div>
  );
}

export function CrossViewPane() {
  const v = crossView.value;
  if (!v) return null;
  const rows = viewItems(v);
  return (
    <section class="listcard" aria-labelledby="xv-title">
      <h2 class="h3" id="xv-title">
        {VIEWS[v].label}
      </h2>
      {rows.length ? (
        <ul class="items">
          {rows.map(({ item, list }) => (
            <ItemRow key={item.id} item={item} list={list} from={list.rec.data.name} />
          ))}
        </ul>
      ) : (
        <p class="nothing">{VIEWS[v].empty}</p>
      )}
    </section>
  );
}
