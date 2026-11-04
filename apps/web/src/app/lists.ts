// SPDX-License-Identifier: AGPL-3.0-or-later
/** List types and list operations (create, rename, retype, privacy, delete). */
import type { ListKind } from '@ours/core/schema';
import { nextDueDate } from '@ours/core/time';
import { signal } from '@preact/signals';
import { byKind, type Entry, findEntry, other, put, remove, store, update } from './model';
import { relDay, today } from './select';

export type ListEntry = Entry & { rec: { kind: 'list' } };
export type ItemEntry = Entry & { rec: { kind: 'item' } };

export interface ListType {
  label: string;
  blurb: string;
  example: string;
  /** 'ideas' lists get "pick one for us"; everything else is a tick-off list. */
  behaviour: 'check' | 'ideas';
  defaultPrivate: boolean;
}

/**
 * One general type and two special ones, each with a behaviour the others
 * don't have. Older 'shopping', 'check' and 'chores' lists are general lists;
 * whether a list comes up in the weekly check-in is its own switch.
 */
export type PickerKind = 'todo' | 'ideas' | 'gifts';

/** The list shown on the Lists screen (the first one if null). */
export const currentList = signal<string | null>(null);

export const LIST_TYPES: Record<PickerKind, ListType> = {
  todo: {
    label: 'List',
    blurb: 'Groceries, chores, to-dos, packing: anything to tick off, together or alone.',
    example: 'Groceries',
    behaviour: 'check',
    defaultPrivate: false,
  },
  ideas: {
    label: 'Date ideas',
    blurb: 'Things to do together. Pick one at random and plan it.',
    example: 'Date ideas',
    behaviour: 'ideas',
    defaultPrivate: false,
  },
  gifts: {
    label: 'Gift ideas',
    blurb: 'Private by default, so surprises stay surprises.',
    example: 'Gift ideas',
    behaviour: 'check',
    defaultPrivate: true,
  },
};

/** The picker's kind for a stored kind (older shopping and generic lists are general lists). */
export const pickerKind = (kind: ListKind): PickerKind =>
  kind === 'ideas' || kind === 'gifts' ? kind : 'todo';
export const typeOf = (kind: ListKind): ListType => LIST_TYPES[pickerKind(kind)];

export function allLists(): ListEntry[] {
  return byKind('list') as ListEntry[];
}

export function itemsOf(listId: string): ItemEntry[] {
  return (byKind('item') as ItemEntry[])
    .filter((i) => i.rec.data.list_id === listId)
    .sort((a, b) => (a.rec.data.sort_key < b.rec.data.sort_key ? -1 : 1));
}

/** All items of a list, in every scope (for moves and deletes). */
function allItemsOf(listId: string): Entry[] {
  return store.value.entries.filter((e) => e.rec.kind === 'item' && e.rec.data.list_id === listId);
}

export function createList(
  name: string,
  kind: ListKind,
  isPrivate: boolean,
  checkin = false,
): string {
  return put(
    'list',
    { name, kind, private: isPrivate, ...(isPrivate ? {} : { checkin }) },
    { scope: isPrivate ? 'user' : 'space' },
  );
}

export function renameList(id: string, name: string): void {
  update<'list'>(id, { name });
}

export function setListKind(id: string, kind: ListKind): void {
  update<'list'>(id, { kind });
}

/**
 * Making a list private (or shared) moves it to another key, so the list and
 * its items are re-created in the new scope. Returns the new list id.
 */
export function setListPrivacy(id: string, isPrivate: boolean): string {
  const list = findEntry(id) as ListEntry | undefined;
  if (!list || list.rec.data.private === isPrivate) return id;
  const items = allItemsOf(id).map((e) => (e.rec.kind === 'item' ? e.rec.data : null));
  remove([id, ...allItemsOf(id).map((e) => e.id)]);
  const scope = isPrivate ? 'user' : 'space';
  const newId = put('list', { ...list.rec.data, private: isPrivate }, { scope });
  for (const item of items) {
    if (item)
      put('item', { ...item, list_id: newId, ...(isPrivate ? { assignee: null } : {}) }, { scope });
  }
  return newId;
}

/** Deletes a list and its items. Returns undo. */
export function deleteList(id: string): () => void {
  return remove([id, ...allItemsOf(id).map((e) => e.id)]);
}

/**
 * Whether a list's open items come up in the weekly check-in. Only shared
 * lists can (the check-in is shared). Older lists: the chores kind, or the
 * list the check-in used to point at.
 */
export function inCheckin(list: ListEntry, legacyId?: string | null): boolean {
  if (list.rec.data.private) return false;
  return list.rec.data.checkin ?? (list.rec.data.kind === 'chores' || list.id === legacyId);
}

export function checkinLists(legacyId?: string | null): ListEntry[] {
  return allLists().filter((l) => inCheckin(l, legacyId));
}

export function setListCheckin(id: string, on: boolean): void {
  update<'list'>(id, { checkin: on });
}

export function ideasList(): ListEntry | undefined {
  return (
    allLists().find((l) => l.rec.data.kind === 'ideas' && !l.rec.data.private) ??
    allLists().find((l) => l.rec.data.kind === 'ideas')
  );
}

/**
 * Ticks an item. A repeating task isn't finished: it moves to its next due
 * date, remembers when it was done and, if the two of you take turns, passes
 * to the other person. Returns undo, and the next due date for repeats.
 */
export function completeItem(item: ItemEntry): { undo: () => void; next: string | null } {
  const before = { ...item.rec.data };
  const d = item.rec.data;
  if (!d.repeat) {
    update<'item'>(item.id, { done: true });
    return { undo: () => update<'item'>(item.id, { done: false }), next: null };
  }
  const t = today.value;
  const next = nextDueDate(d.repeat, d.due, t);
  const assignee =
    d.rotate && (d.assignee === 'a' || d.assignee === 'b') ? other(d.assignee) : d.assignee;
  update<'item'>(
    item.id,
    next ? { due: next, last_done: t, assignee, done: false } : { done: true, last_done: t },
  );
  return { undo: () => update<'item'>(item.id, before), next };
}

/** "Due today", "Due Friday", "Overdue · was Mon, Nov 2". */
export function dueText(due: string): { text: string; late: boolean } {
  const t = today.value;
  if (due < t) return { text: `Overdue · was ${relDay(due)}`, late: true };
  return { text: due === t ? 'Due today' : `Due ${relDay(due)}`, late: false };
}
