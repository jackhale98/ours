// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Views across all lists: what's due this week, what's on me, short ideas
 * for a free evening, and what we both want. Shown on the Lists screen above
 * the lists themselves.
 */
import { IDEA_LENGTHS } from '@ours/core/schema';
import { addDays } from '@ours/core/time';
import { computed, signal } from '@preact/signals';
import {
  activeLists,
  bothWant,
  dueOf,
  featuresOf,
  type ItemEntry,
  itemsOf,
  type ListEntry,
} from '../lists';
import { viewer } from '../model';
import { relDay, today } from '../select';
import { ItemRow } from './Lists';

export type CrossView = 'due' | 'mine' | 'short' | 'both';
export const crossView = signal<CrossView | null>(null);

const VIEWS: Record<CrossView, { label: string; empty: string }> = {
  due: { label: 'Due this week', empty: 'Nothing due in the next seven days.' },
  mine: { label: 'On me', empty: 'Nothing is waiting on you.' },
  short: { label: 'Short ideas', empty: 'No ideas that take three hours or less.' },
  both: { label: 'We both want', empty: 'Nothing you’ve both hearted yet.' },
};

type ViewRow = { item: ItemEntry; list: ListEntry };

/**
 * Every view's items, in one pass over the lists, once per change of the
 * store or the day (review 0008, L-5: it used to be four passes per render).
 */
const allViews = computed((): Record<CrossView, ViewRow[]> => {
  const out: Record<CrossView, (ViewRow & { key: string })[]> = {
    due: [],
    mine: [],
    short: [],
    both: [],
  };
  const week = addDays(today.value, 7);
  const me = viewer.value;
  for (const list of activeLists()) {
    const f = featuresOf(list);
    const tick = f.has('tick');
    for (const item of itemsOf(list.id)) {
      const d = item.rec.data;
      if (tick && d.done) continue;
      if (tick && f.has('due')) {
        const due = dueOf(item);
        if (due && due <= week) out.due.push({ item, list, key: due });
      }
      if (tick && d.assignee === me) out.mine.push({ item, list, key: dueOf(item) ?? '~' });
      const fits = d.length ? IDEA_LENGTHS[d.length] <= IDEA_LENGTHS.evening : false;
      if (!tick && f.has('plan') && fits) out.short.push({ item, list, key: d.text });
      if (f.has('hearts') && bothWant(item)) out.both.push({ item, list, key: d.text });
    }
  }
  const sorted = (rows: (ViewRow & { key: string })[]) =>
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    due: sorted(out.due),
    mine: sorted(out.mine),
    short: sorted(out.short),
    both: sorted(out.both),
  };
});

/** The items a view shows, with their lists, in the order to show them. */
export function viewItems(view: CrossView): ViewRow[] {
  return allViews.value[view];
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

function Rows({ rows }: { rows: ViewRow[] }) {
  return (
    <ul class="items">
      {rows.map(({ item, list }) => (
        <ItemRow key={item.id} item={item} list={list} from={list.rec.data.name} />
      ))}
    </ul>
  );
}

/** "Due this week" under Overdue, Today and then each day (review 0008, L-12). */
function bands(v: CrossView, rows: ViewRow[]): [string | null, ViewRow[], boolean][] {
  if (v !== 'due') return [[null, rows, false]];
  const t = today.value;
  const out = new Map<string, [string, ViewRow[], boolean]>();
  for (const r of rows) {
    const d = dueOf(r.item) ?? t;
    const key = d < t ? 'late' : d;
    const title = d < t ? 'Overdue' : relDay(d);
    const got = out.get(key);
    if (got) got[1].push(r);
    else out.set(key, [title, [r], d < t]);
  }
  return [...out.entries()]
    .sort(([a], [b]) => (a === 'late' ? -1 : b === 'late' ? 1 : a < b ? -1 : 1))
    .map(([, g]) => g);
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
        bands(v, rows).map(([title, group, late]) =>
          title ? (
            <section class="isection" key={title} aria-label={title}>
              <h3 class={`eyebrow isec-h${late ? ' late' : ''}`}>
                {title}
                <span class="n">{group.length}</span>
              </h3>
              <Rows rows={group} />
            </section>
          ) : (
            <Rows key="all" rows={group} />
          ),
        )
      ) : (
        <p class="nothing">{VIEWS[v].empty}</p>
      )}
    </section>
  );
}
