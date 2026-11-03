// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { completeItem, type ItemEntry } from './lists';
import { findEntry, loadEntries, put, setBackend } from './model';
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
