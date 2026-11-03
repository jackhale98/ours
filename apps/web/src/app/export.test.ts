// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateRecoveryPhrase } from '@ours/core/crypto';
import { parseIcs } from '@ours/core/ics';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  calendarExport,
  encryptedExport,
  ImportError,
  importExport,
  readableExport,
} from './export';
import { createEvent, loadEntries, put, setBackend, store, visible } from './model';

beforeEach(() => {
  setBackend({ mode: 'demo', deviceId: (s) => `test-${s}`, write: () => {} });
  loadEntries('a', []);
});

function sample() {
  createEvent({
    title: 'Dinner at Rosa’s',
    start: '2026-11-06T19:00',
    end: '2026-11-06T21:00',
    all_day: false,
    tz: 'Europe/London',
    rrule: null,
    away: false,
    owner: 'both',
    status: 'confirmed',
    proposed_by: null,
    privacy: 'full',
    location: 'Rosa’s, Hackney',
    notes: 'Book a table',
    countdown: false,
    stub_id: null,
  });
  createEvent({
    title: 'Therapy',
    start: '2026-11-05T17:00',
    end: '2026-11-05T18:00',
    all_day: false,
    tz: 'Europe/London',
    rrule: 'FREQ=WEEKLY',
    away: false,
    owner: 'a',
    status: 'confirmed',
    proposed_by: null,
    privacy: 'busy',
    location: null,
    notes: null,
    countdown: false,
    stub_id: null,
  });
  const list = put('list', { name: 'Groceries', kind: 'shopping', private: false });
  put('item', {
    list_id: list,
    text: 'Oat milk',
    done: false,
    assignee: 'b',
    due: null,
    sort_key: 'm',
  });
}

const snapshot = () =>
  visible.value
    .map((e) => ({ id: e.id, kind: e.rec.kind, scope: e.scope, data: e.rec.data }))
    .sort((x, y) => x.id.localeCompare(y.id));

describe('export and import', () => {
  it('round-trips a readable export through a wipe', () => {
    sample();
    const before = snapshot();
    expect(before.length).toBeGreaterThanOrEqual(4);
    const file = readableExport();
    loadEntries('a', []);
    expect(visible.value).toHaveLength(0);
    const result = importExport(file);
    expect(result).toMatchObject({ status: 'done', added: before.length, skipped: 0 });
    expect(snapshot()).toEqual(before);
    // Importing again changes nothing.
    expect(importExport(file)).toMatchObject({ added: 0, updated: 0, skipped: before.length });
  });

  it('round-trips an encrypted export, and only with the right phrase', () => {
    sample();
    const before = snapshot();
    const words = generateRecoveryPhrase();
    const file = encryptedExport(words);
    expect(file).not.toContain('Dinner');
    expect(file).not.toContain('Groceries');
    loadEntries('a', []);
    expect(importExport(file)).toEqual({ status: 'needs-phrase' });
    expect(() => importExport(file, generateRecoveryPhrase())).toThrow(ImportError);
    expect(importExport(file, words)).toMatchObject({ status: 'done', added: before.length });
    expect(snapshot()).toEqual(before);
  });

  it('refuses files that are not exports and skips invalid records', () => {
    expect(() => importExport('nope')).toThrow(ImportError);
    expect(() => importExport('{"format":"other"}')).toThrow(ImportError);
    const bad = JSON.stringify({
      format: 'ours-export',
      v: 1,
      entries: [
        { id: 'x1', kind: 'event', scope: 'space', owner: null, updated_at: 1, data: { title: 1 } },
        {
          id: 'x2',
          kind: 'busy_stub',
          scope: 'space',
          owner: null,
          updated_at: 1,
          data: {
            start: '2026-11-05T17:00',
            end: '2026-11-05T18:00',
            all_day: false,
            tz: 'UTC',
            rrule: null,
            away: false,
            owner: 'b',
          },
        },
      ],
    });
    expect(importExport(bad)).toMatchObject({ status: 'done', added: 0, skipped: 2 });
    expect(store.value.entries).toHaveLength(0);
  });

  it('exports plans as iCalendar that reads back', () => {
    sample();
    const cal = parseIcs(calendarExport());
    const titles = cal.events.map((e) => e.title).sort();
    expect(titles).toEqual(['Dinner at Rosa’s', 'Therapy']);
  });
});
