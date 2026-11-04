// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bothWant,
  completeItem,
  copyList,
  createList,
  didIt,
  dueOf,
  featuresOf,
  type ItemEntry,
  itemsOf,
  type ListEntry,
  lastDid,
  listsForPlan,
  react,
  STARTING_POINTS,
  type StartingPoint,
  savedStartingPoints,
  saveStartingPoint,
  setFeatures,
  startOver,
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
