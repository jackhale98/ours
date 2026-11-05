// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Waiting on you": everything that needs this person's answer or action,
 * in one place, in the order it's worth doing:
 *   0. inviting the partner, while nobody has joined the space,
 *   1. plans the partner asked about (answer yes or no),
 *   2. plans I asked about that the partner can't make (ask again or remove),
 *   3. ideas you planned that have happened: "How was it?" (review 0008, L-10),
 *   5. checklists for plans that are over: archive them?
 *   4. my tasks that are overdue or due by tomorrow, and shared ones nobody
 *      has taken yet. Several overdue on one list are one entry ("12 overdue
 *      on House projects"), so a real question isn't lost among chores (L-12).
 * Past plans drop out: a question about last Tuesday no longer needs an answer.
 */
import { addDays } from '@ours/core/time';
import { computed, signal } from '@preact/signals';
import { partnerMissing } from './invite';
import {
  activeLists,
  dueOf,
  featuresOf,
  type ItemEntry,
  ideasToRecall,
  itemsOf,
  type ListEntry,
} from './lists';
import { byKind, type Entry, findEntry, partner, viewer } from './model';
import { awaitingMe, stillAhead, today } from './select';

export type Waiting =
  | { kind: 'invite'; id: string }
  | { kind: 'ask'; id: string; entry: Entry }
  | { kind: 'declined'; id: string; entry: Entry }
  | { kind: 'task'; id: string; item: ItemEntry; list: ListEntry }
  | { kind: 'overdue'; id: string; items: ItemEntry[]; list: ListEntry }
  | { kind: 'recall'; id: string; item: ItemEntry; planId: string; date: string }
  | { kind: 'archive'; id: string; list: ListEntry; plan: string };

/** "How was it?" questions put aside on this device ("We didn't go"). */
const RECALL_KEY = 'ours-recall-off';
export const recallOff = signal<readonly string[]>(
  (() => {
    try {
      const v = JSON.parse(localStorage.getItem(RECALL_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  })(),
);
export function putRecallAside(key: string): () => void {
  const before = recallOff.value;
  const save = (v: readonly string[]) => {
    recallOff.value = v;
    try {
      localStorage.setItem(RECALL_KEY, JSON.stringify(v.slice(-200)));
    } catch {
      // private mode: asked again next time
    }
  };
  save([...before, key]);
  return () => save(before);
}

const upcoming = stillAhead;

/** Tasks worth raising: due by tomorrow (or overdue), mine or nobody's. */
export function tasksFor(horizonDays: number): { item: ItemEntry; list: ListEntry }[] {
  const t = today.value;
  const until = addDays(t, horizonDays);
  const me = viewer.value;
  const out: { item: ItemEntry; list: ListEntry }[] = [];
  for (const list of activeLists()) {
    const f = featuresOf(list);
    if (!f.has('tick') || !f.has('due')) continue;
    for (const item of itemsOf(list.id)) {
      const d = item.rec.data;
      const due = dueOf(item);
      if (d.done || !due || due > until) continue;
      if (d.assignee && d.assignee !== me) continue;
      out.push({ item, list });
    }
  }
  return out.sort((a, b) => ((dueOf(a.item) ?? '') < (dueOf(b.item) ?? '') ? -1 : 1));
}

export const waiting = computed<Waiting[]>(() => {
  const t = today.value;
  const me = viewer.value;
  const p = partner.value;
  const asks = awaitingMe.value
    .filter((e) => upcoming(e, t))
    .map((e): Waiting => ({ kind: 'ask', id: e.id, entry: e }));
  const declined = byKind('event')
    .filter(
      (e) =>
        e.rec.kind === 'event' &&
        e.rec.data.status === 'declined' &&
        e.rec.data.proposed_by === me &&
        e.rec.data.owner !== p &&
        upcoming(e, t),
    )
    .map((e): Waiting => ({ kind: 'declined', id: e.id, entry: e }));
  const off = new Set(recallOff.value);
  const recalls = ideasToRecall.value
    .filter((r) => !off.has(`${r.item.id}:${r.date}`))
    .map((r): Waiting => ({ kind: 'recall', id: `recall:${r.item.id}`, ...r }));
  // A trip that's over: its checklist can be put away (review 0008, L-2).
  const finished = activeLists().flatMap((list): Waiting[] => {
    const plan = list.rec.data.plan_id ? findEntry(list.rec.data.plan_id) : undefined;
    if (plan?.rec.kind !== 'event' || plan.rec.data.rrule) return [];
    const last = plan.rec.data.all_day
      ? addDays(plan.rec.data.end.slice(0, 10), -1)
      : plan.rec.data.end.slice(0, 10);
    if (last >= t || off.has(`archive:${list.id}`)) return [];
    return [{ kind: 'archive', id: `archive:${list.id}`, list, plan: plan.rec.data.title }];
  });
  // Two or more overdue on one list: one entry for the list.
  const due = tasksFor(1);
  const lateBy = new Map<string, ItemEntry[]>();
  for (const { item, list } of due) {
    if ((dueOf(item) ?? t) >= t) continue;
    lateBy.set(list.id, [...(lateBy.get(list.id) ?? []), item]);
  }
  const folded = new Set<string>();
  const tasks: Waiting[] = [];
  for (const { item, list } of due) {
    const late = lateBy.get(list.id);
    if (late && late.length > 1 && late.includes(item)) {
      if (!folded.has(list.id))
        tasks.push({ kind: 'overdue', id: `overdue:${list.id}`, items: late, list });
      folded.add(list.id);
    } else tasks.push({ kind: 'task', id: item.id, item, list });
  }
  // Nobody to plan with yet: inviting them comes first.
  const invite: Waiting[] = partnerMissing() ? [{ kind: 'invite', id: 'invite' }] : [];
  return [...invite, ...asks, ...declined, ...recalls, ...tasks, ...finished];
});
