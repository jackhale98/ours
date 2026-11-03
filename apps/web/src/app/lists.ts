// SPDX-License-Identifier: AGPL-3.0-or-later
/** List types and list operations (create, rename, retype, privacy, delete). */
import type { ListKind } from '@ours/core/schema';
import { byKind, type Entry, findEntry, put, remove, store, update } from './model';

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
 * One general type and three special ones, each with a behaviour the
 * others don't have. Older 'shopping' and 'check' lists are general lists.
 */
export type PickerKind = 'todo' | 'chores' | 'ideas' | 'gifts';

export const LIST_TYPES: Record<PickerKind, ListType> = {
  todo: {
    label: 'List',
    blurb: 'Groceries, to-dos, packing: anything to tick off, together or alone.',
    example: 'Groceries',
    behaviour: 'check',
    defaultPrivate: false,
  },
  chores: {
    label: 'Chores',
    blurb: 'Jobs around the home, each with an owner. They come up in the weekly check-in.',
    example: 'Home',
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
  kind === 'shopping' || kind === 'check' ? 'todo' : kind;
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

export function createList(name: string, kind: ListKind, isPrivate: boolean): string {
  return put('list', { name, kind, private: isPrivate }, { scope: isPrivate ? 'user' : 'space' });
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

/** The list the weekly check-in uses for chores. */
export function choresList(preferredId: string | null | undefined): ListEntry | undefined {
  const lists = allLists().filter((l) => !l.rec.data.private);
  return (
    lists.find((l) => l.id === preferredId) ??
    lists.find((l) => l.rec.data.kind === 'chores') ??
    lists.find((l) => typeOf(l.rec.data.kind).behaviour === 'check')
  );
}

export function ideasList(): ListEntry | undefined {
  return (
    allLists().find((l) => l.rec.data.kind === 'ideas' && !l.rec.data.private) ??
    allLists().find((l) => l.rec.data.kind === 'ideas')
  );
}
