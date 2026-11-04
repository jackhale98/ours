// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { createList } from './lists';
import {
  addComment,
  createEvent,
  type EventData,
  loadEntries,
  put,
  setBackend,
  setViewer,
} from './model';
import { fold, matches, search, terms } from './search';
import { now } from './select';

const plan = (over: Partial<EventData>): EventData => ({
  title: 'Plan',
  start: '2026-11-10T19:00',
  end: '2026-11-10T20:00',
  all_day: false,
  tz: 'UTC',
  rrule: null,
  owner: 'both',
  status: 'confirmed',
  proposed_by: null,
  privacy: 'full',
  location: null,
  notes: null,
  countdown: false,
  away: false,
  stub_id: null,
  ...over,
});

beforeEach(() => {
  setBackend({ mode: 'demo', deviceId: (s) => `test-${s}`, write: () => {} });
  loadEntries('a', []);
  now.value = Date.parse('2026-11-04T12:00:00Z');
});

describe('matching', () => {
  it('ignores case and accents, and matches from the start of words', () => {
    expect(fold('Café ÉTÉ')).toBe('cafe ete');
    expect(matches(terms('cafe'), 'Brunch at Café Luna')).toBe(true);
    expect(matches(terms('din'), 'Dinner with Jo')).toBe(true);
    expect(matches(terms('din'), 'Maya’s wedding')).toBe(false);
    expect(matches(terms('luna brunch'), 'Brunch at Café Luna')).toBe(true);
    expect(matches(terms('luna dinner'), 'Brunch at Café Luna')).toBe(false);
    expect(matches(terms('(a+'), 'nothing (a+b)')).toBe(true); // no regex injection
  });
});

describe('search', () => {
  it('finds plans by title, place or notes, upcoming first', () => {
    createEvent(
      plan({ title: 'Dinner at Vic’s', start: '2026-11-20T19:00', end: '2026-11-20T21:00' }),
    );
    createEvent(plan({ title: 'Lunch', location: 'Diner on 5th' }));
    createEvent(plan({ title: 'Old dinner', start: '2026-10-01T19:00', end: '2026-10-01T20:00' }));
    const hits = search('din').filter((h) => h.kind === 'plan');
    expect(hits.map((h) => h.kind === 'plan' && h.title)).toEqual([
      'Lunch',
      'Dinner at Vic’s',
      'Old dinner',
    ]);
  });

  it('a repeating plan points at its next day', () => {
    createEvent(
      plan({
        title: 'Swim',
        start: '2026-10-05T07:00',
        end: '2026-10-05T08:00',
        rrule: 'FREQ=WEEKLY',
      }),
    );
    const hit = search('swim')[0];
    expect(hit?.kind === 'plan' && hit.occ).toBe('2026-11-09T07:00');
  });

  it('finds list items, list names and notes on plans', () => {
    const list = createList('Groceries', 'todo', false);
    put('item', {
      list_id: list,
      text: 'Oat milk',
      done: false,
      assignee: null,
      due: null,
      sort_key: 'V',
    } as never);
    const id = createEvent(plan({ title: 'Brunch' }));
    addComment(id, 'Bring the oat cookies');
    const kinds = search('oat').map((h) => h.kind);
    expect(kinds).toEqual(['item', 'note']);
    expect(search('groc').map((h) => h.kind)).toEqual(['list']);
  });

  it('never finds a partner’s private plan by its title', () => {
    createEvent(plan({ title: 'Therapy', owner: 'a', privacy: 'busy' }));
    expect(search('therapy')).toHaveLength(1); // the owner finds it
    setViewer('b');
    expect(search('therapy')).toHaveLength(0);
  });
});
