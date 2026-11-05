// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeLists,
  allLists,
  archivedLists,
  bothWant,
  completeItem,
  copyList,
  createList,
  didIt,
  dueOf,
  featuresOf,
  type ItemEntry,
  itemsOf,
  keepSection,
  type ListEntry,
  lastDid,
  listsForPlan,
  moveItem,
  moveItems,
  moveList,
  moveSection,
  movesScope,
  react,
  readItemText,
  renameSection,
  STARTING_POINTS,
  type StartingPoint,
  sameItem,
  savedStartingPoints,
  saveStartingPoint,
  sectionsOf,
  setArchived,
  setFeatures,
  setPinned,
  startOver,
  suggestItems,
  toggleHeart,
} from './lists';
import { createEvent, findEntry, loadEntries, put, setBackend, update } from './model';
import { now, today } from './select';

beforeEach(() => {
  setBackend({ mode: 'demo', deviceId: (s) => `test-${s}`, write: () => {} });
  loadEntries('a', []);
  now.value = Date.parse('2026-11-03T12:00:00Z'); // a Tuesday
});

function item(extra: Record<string, unknown>) {
  const list = put('list', { name: 'Home', kind: 'todo', private: false });
  const id = put('item', {
    list_id: list,
    text: 'Bins',
    done: false,
    assignee: 'a',
    due: '2026-11-02',
    sort_key: 'V',
    ...extra,
  } as never);
  return () => findEntry(id) as ItemEntry;
}

describe('repeating tasks', () => {
  it('ticking moves an overdue weekly task to the next date and passes it on', () => {
    expect(today.value).toBe('2026-11-03');
    const get = item({ repeat: 'FREQ=WEEKLY;BYDAY=MO', rotate: true });
    const { next, undo } = completeItem(get());
    expect(next).toBe('2026-11-09');
    expect(get().rec.data).toMatchObject({
      done: false,
      due: '2026-11-09',
      last_done: '2026-11-03',
      assignee: 'b',
    });
    undo();
    expect(get().rec.data).toMatchObject({ due: '2026-11-02', assignee: 'a', done: false });
  });

  it('done early counts from the due date; without turns the owner stays', () => {
    const get = item({ repeat: 'FREQ=WEEKLY', due: '2026-11-06' });
    expect(completeItem(get()).next).toBe('2026-11-13');
    expect(get().rec.data.assignee).toBe('a');
  });

  it('an ordinary item is simply done', () => {
    const get = item({});
    const { undo } = completeItem(get());
    expect(get().rec.data.done).toBe(true);
    undo();
    expect(get().rec.data.done).toBe(false);
  });
});

describe('features, starting points and memories', () => {
  const sp = (id: string) => STARTING_POINTS.find((s) => s.id === id) as StartingPoint;
  const entry = (id: string) => findEntry(id) as ListEntry;
  const addItem = (list: string, text: string, more: Record<string, unknown> = {}) =>
    put('item', {
      list_id: list,
      text,
      done: false,
      assignee: null,
      due: null,
      sort_key: 'm',
      ...more,
    });

  it('gives lists made before features the behaviour they had', () => {
    const ideas = put('list', { name: 'Old ideas', kind: 'ideas', private: false });
    const todo = put('list', { name: 'Old list', kind: 'check', private: false });
    expect([...featuresOf(entry(ideas))]).toEqual(['pick', 'plan', 'length']);
    expect([...featuresOf(entry(todo))]).toEqual(['tick', 'who', 'due']);
  });

  it('keeps an old kind that older apps understand, as features change', () => {
    const id = createList('Films', sp('watch'), false);
    expect(entry(id).rec.data.kind).toBe('ideas');
    setFeatures(id, ['tick', 'notes']);
    expect(entry(id).rec.data).toMatchObject({ kind: 'todo', features: ['tick', 'notes'] });
    // Who's on it means nothing on a private list.
    const mine = createList('Mine', sp('todo'), true);
    expect(featuresOf(entry(mine)).has('who')).toBe(false);
  });

  it('starts over, and copies without hearts or history', () => {
    const id = createList('Packing', sp('packing'), false);
    const a = addItem(id, 'Socks', {
      done: true,
      hearts: { a: true },
      did: [{ date: '2026-10-01' }],
    });
    const undo = startOver(id);
    expect((findEntry(a) as ItemEntry).rec.data.done).toBe(false);
    undo();
    expect((findEntry(a) as ItemEntry).rec.data.done).toBe(true);
    const copy = copyList(id) as string;
    const copied = itemsOf(copy)[0]?.rec.data;
    expect(copied).toMatchObject({ text: 'Socks', done: false });
    expect(copied?.hearts).toBeUndefined();
    expect(copied?.did).toBeUndefined();
  });

  it('records what we did and how each of us found it', () => {
    const id = createList('Dates', sp('dates'), false);
    const item = () => itemsOf(id)[0] as ItemEntry;
    addItem(id, 'Pottery');
    toggleHeart(item(), 'a');
    toggleHeart(item(), 'b');
    expect(bothWant(item())).toBe(true);
    didIt(item(), '2026-10-05');
    react(item(), 0, 'a', 'loved');
    react(item(), 0, 'b', 'meh');
    expect(item().rec.data.did).toEqual([{ date: '2026-10-05', a: 'loved', b: 'meh' }]);
    expect(lastDid(item())?.date).toBe('2026-10-05');
  });

  it('dates a checklist item from its plan, and follows the plan when it moves', () => {
    const plan = createEvent({
      title: 'Lisbon',
      start: '2026-12-10',
      end: '2026-12-14',
      all_day: true,
      tz: null,
      rrule: null,
      away: true,
      owner: 'both',
      status: 'confirmed',
      proposed_by: null,
      privacy: 'full',
      location: null,
      notes: null,
      countdown: false,
      stub_id: null,
    });
    const id = createList('For Lisbon', sp('packing'), false, { planId: plan });
    const item = addItem(id, 'Passports', { before_days: 2 });
    expect(dueOf(findEntry(item) as ItemEntry)).toBe('2026-12-08');
    expect(listsForPlan(plan).map((l) => l.id)).toEqual([id]);
    update<'event'>(plan, { start: '2026-12-20', end: '2026-12-24' });
    expect(dueOf(findEntry(item) as ItemEntry)).toBe('2026-12-18');
  });

  it('saves your own starting points for both of you', () => {
    put('settings', { week_start: 1 });
    const id = createList('Camping', sp('blank'), false);
    setFeatures(id, ['tick', 'qty']);
    saveStartingPoint(entry(id), 'Camping');
    expect(savedStartingPoints()).toMatchObject([{ label: 'Camping', features: ['tick', 'qty'] }]);
  });
});

describe('order, archive, sections and moves (review 0008, L-2, L-3, L-7)', () => {
  // Ids in the order made (real ids are time-ordered; these are made in the same millisecond).
  let made = 0;
  const mk = (name: string, extra: Record<string, unknown> = {}) =>
    put('list', { name, kind: 'todo', private: false, ...extra } as never, {
      id: `list-${String(++made).padStart(3, '0')}`,
      scope: extra.private ? 'user' : 'space',
    });
  const names = (lists: ListEntry[]) => lists.map((l) => l.rec.data.name);
  const add = (list: string, text: string, key: string, extra: Record<string, unknown> = {}) =>
    put(
      'item',
      {
        list_id: list,
        text,
        done: false,
        assignee: null,
        due: null,
        sort_key: key,
        ...extra,
      } as never,
      { scope: (findEntry(list) as ListEntry).scope },
    );
  const texts = (list: string) => itemsOf(list).map((i) => i.rec.data.text);

  it('keeps pinned lists first, moves lists, and archives them out of the way', () => {
    const a = mk('Home');
    mk('Groceries');
    const c = mk('Gifts');
    expect(names(activeLists())).toEqual(['Home', 'Groceries', 'Gifts']);
    moveList(c, -1);
    expect(names(activeLists())).toEqual(['Home', 'Gifts', 'Groceries']);
    moveList(a, 1);
    expect(names(activeLists())).toEqual(['Gifts', 'Home', 'Groceries']);
    setPinned(a, true);
    expect(names(activeLists())[0]).toBe('Home');
    const undo = setArchived(a, true);
    expect(names(activeLists())).toEqual(['Gifts', 'Groceries']);
    expect(names(archivedLists())).toEqual(['Home']);
    expect(names(allLists())).toContain('Home');
    undo();
    expect(names(activeLists())).toContain('Home');
  });

  it('keeps sections where they are as items are added, and moves and renames them', () => {
    const l = mk('Groceries');
    add(l, 'Milk', 'V', { section: 'Dairy' });
    keepSection(l, 'Dairy');
    add(l, 'Tomatoes', 'U', { section: 'Produce' });
    keepSection(l, 'Produce');
    add(l, 'Peas', 'T', { section: 'Frozen' });
    keepSection(l, 'Frozen');
    // New items go on top, but the sections keep their order.
    expect(sectionsOf(l)).toEqual(['Dairy', 'Produce', 'Frozen']);
    moveSection(l, 'Frozen', -1);
    expect(sectionsOf(l)).toEqual(['Dairy', 'Frozen', 'Produce']);
    const undo = renameSection(l, 'Dairy', 'Fridge');
    expect(sectionsOf(l)).toEqual(['Fridge', 'Frozen', 'Produce']);
    expect(itemsOf(l).find((i) => i.rec.data.text === 'Milk')?.rec.data.section).toBe('Fridge');
    undo();
    expect(sectionsOf(l)).toEqual(['Dairy', 'Frozen', 'Produce']);
    expect(itemsOf(l).find((i) => i.rec.data.text === 'Milk')?.rec.data.section).toBe('Dairy');
  });

  it('moves an item up, down and to the top, renumbering tied keys first', () => {
    const l = mk('Packing');
    add(l, 'A', 'V');
    add(l, 'B', 'W');
    add(l, 'C', 'X');
    const find = (t: string) => itemsOf(l).find((i) => i.rec.data.text === t) as ItemEntry;
    moveItem(find('C'), 'up', itemsOf(l));
    expect(texts(l)).toEqual(['A', 'C', 'B']);
    moveItem(find('A'), 'down', itemsOf(l));
    expect(texts(l)).toEqual(['C', 'A', 'B']);
    moveItem(find('B'), 'top', itemsOf(l));
    expect(texts(l)).toEqual(['B', 'C', 'A']);
    const tied = mk('Tied');
    add(tied, 'x', 'V');
    add(tied, 'y', 'V');
    add(tied, 'z', 'V');
    const z = itemsOf(tied).at(-1) as ItemEntry;
    moveItem(z, 'up', itemsOf(tied));
    expect(itemsOf(tied).at(1)?.id).toBe(z.id);
  });

  it('moves items to the end of another list, and across privacy re-creates them', () => {
    const from = mk('Weekly shop');
    const to = mk('Costco run');
    const mine = mk('Just me', { private: true });
    add(to, 'Water', 'V');
    const milk = add(from, 'Milk', 'V', { assignee: 'b', section: 'Dairy' });
    const bread = add(from, 'Bread', 'W');
    const moved = moveItems([milk, bread], to);
    expect(moved.moved).toBe(2);
    expect(texts(to)).toEqual(['Water', 'Milk', 'Bread']);
    expect(sectionsOf(to)).toContain('Dairy');
    moved.undo();
    expect(texts(from)).toEqual(['Milk', 'Bread']);
    expect(texts(to)).toEqual(['Water']);

    expect(movesScope(findEntry(from) as ListEntry, findEntry(mine) as ListEntry)).toBe(true);
    const away = moveItems([milk], mine);
    const copy = itemsOf(mine)[0];
    expect(copy?.rec.data.text).toBe('Milk');
    expect(copy?.scope).toBe('user');
    expect(copy?.rec.data.assignee).toBeNull();
    expect(findEntry(milk)).toBeUndefined();
    away.undo();
    expect(itemsOf(mine)).toHaveLength(0);
    expect((findEntry(milk) as ItemEntry).rec.data.assignee).toBe('b');
  });
});

describe('reading what is typed into a list (review 0008, L-8)', () => {
  const opts = { qty: true, who: true, me: 'a' as const, names: { a: 'Sam', b: 'Alex' } };
  it.each([
    ['2 x milk', { text: 'milk', qty: '2', assignee: null }],
    ['Milk x2', { text: 'Milk', qty: '2', assignee: null }],
    ['eggs 12x', { text: 'eggs', qty: '12', assignee: null }],
    ['Flour 500 g', { text: 'Flour', qty: '500 g', assignee: null }],
    ['Hoover the stairs @Alex', { text: 'Hoover the stairs', qty: null, assignee: 'b' }],
    ['@me bins', { text: 'bins', qty: null, assignee: 'a' }],
    ['Email @someone', { text: 'Email @someone', qty: null, assignee: null }],
    ['7 Up', { text: '7 Up', qty: null, assignee: null }],
    ['x2', { text: 'x2', qty: null, assignee: null }],
  ])('%s', (input, expected) => {
    expect(readItemText(input, opts)).toEqual(expected);
  });

  it('leaves the text alone when the list has no such fields', () => {
    expect(readItemText('2 x milk @Alex', { ...opts, qty: false, who: false })).toEqual({
      text: '2 x milk @Alex',
      qty: null,
      assignee: null,
    });
  });

  it('suggests done items first and finds the same item in any case', () => {
    const list = put('list', { name: 'Shop', kind: 'shopping', private: false });
    const add = (text: string, done: boolean, key: string) =>
      put('item', { list_id: list, text, done, assignee: null, due: null, sort_key: key });
    add('Sourdough', false, 'V');
    add('Soup', true, 'W');
    add('Sour cream', true, 'X');
    expect(suggestItems(list, 'sou').map((i) => i.rec.data.text)).toEqual([
      'Soup',
      'Sour cream',
      'Sourdough',
    ]);
    expect(suggestItems(list, 's')).toEqual([]);
    expect(sameItem(list, ' soup ')?.rec.data.text).toBe('Soup');
    expect(sameItem(list, 'bread')).toBeUndefined();
  });
});
