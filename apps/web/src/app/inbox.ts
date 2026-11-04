// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Waiting on you": everything that needs this person's answer or action,
 * in one place, in the order it's worth doing:
 *   0. inviting the partner, while nobody has joined the space,
 *   1. plans the partner asked about (answer yes or no),
 *   2. plans I asked about that the partner can't make (ask again or remove),
 *   3. my tasks that are overdue or due by tomorrow, and shared ones nobody
 *      has taken yet.
 * Past plans drop out: a question about last Tuesday no longer needs an answer.
 */
import { addDays } from '@ours/core/time';
import { computed } from '@preact/signals';
import { partnerMissing } from './invite';
import { allLists, type ItemEntry, itemsOf, type ListEntry } from './lists';
import { byKind, type Entry, partner, viewer } from './model';
import { awaitingMe, today } from './select';

export type Waiting =
  | { kind: 'invite'; id: string }
  | { kind: 'ask'; id: string; entry: Entry }
  | { kind: 'declined'; id: string; entry: Entry }
  | { kind: 'task'; id: string; item: ItemEntry; list: ListEntry };

/** Whether an event's last day is today or later. */
function upcoming(e: Entry, t: string): boolean {
  if (e.rec.kind !== 'event') return false;
  const d = e.rec.data;
  // All-day ends are exclusive: a one-day plan on the 4th ends on the 5th.
  const last = d.all_day ? addDays(d.end.slice(0, 10), -1) : d.end.slice(0, 10);
  return last >= t;
}

/** Tasks worth raising: due by tomorrow (or overdue), mine or nobody's. */
export function tasksFor(horizonDays: number): { item: ItemEntry; list: ListEntry }[] {
  const t = today.value;
  const until = addDays(t, horizonDays);
  const me = viewer.value;
  const out: { item: ItemEntry; list: ListEntry }[] = [];
  for (const list of allLists()) {
    for (const item of itemsOf(list.id)) {
      const d = item.rec.data;
      if (d.done || !d.due || d.due > until) continue;
      if (d.assignee && d.assignee !== me) continue;
      out.push({ item, list });
    }
  }
  return out.sort((a, b) => ((a.item.rec.data.due ?? '') < (b.item.rec.data.due ?? '') ? -1 : 1));
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
  const tasks = tasksFor(1).map(
    ({ item, list }): Waiting => ({ kind: 'task', id: item.id, item, list }),
  );
  // Nobody to plan with yet: inviting them comes first.
  const invite: Waiting[] = partnerMissing() ? [{ kind: 'invite', id: 'invite' }] : [];
  return [...invite, ...asks, ...declined, ...tasks];
});
