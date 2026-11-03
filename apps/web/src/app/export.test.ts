// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateRecoveryPhrase } from '@ours/core/crypto';
import { parseIcs } from '@ours/core/ics';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  calendarExport,
  encryptedExport,
  ImportError,
  type ImportPlan,
  planImport,
  readableExport,
} from './export';
import {
  addComment,
  createEvent,
  type EventData,
  loadEntries,
  put,
  remove,
  setBackend,
  setEventPrivacy,
  store,
  visible,
} from './model';

beforeEach(() => {
  setBackend({ mode: 'demo', deviceId: (s) => `test-${s}`, write: () => {} });
  loadEntries('a', []);
});

const event = (title: string, extra: Partial<EventData> = {}): EventData => ({
  title,
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
  ...extra,
});

function sample() {
  const dinner = createEvent(event('Dinner at Rosa’s'));
  addComment(dinner, 'Booked for 7');
  createEvent(event('Therapy', { owner: 'a', privacy: 'busy', rrule: 'FREQ=WEEKLY' }));
  const list = put('list', { name: 'Groceries', kind: 'shopping', private: false });
  put('item', {
    list_id: list,
    text: 'Oat milk',
    done: false,
    assignee: 'b',
    due: null,
    sort_key: 'm',
  });
  const gifts = put(
    'list',
    { name: 'Gift ideas', kind: 'gifts', private: true },
    { scope: 'user' },
  );
  put(
    'item',
    { list_id: gifts, text: 'Scarf', done: false, assignee: null, due: null, sort_key: 'm' },
    { scope: 'user' },
  );
  return { dinner, list };
}

/** What a person sees, independent of ids. */
const content = () =>
  visible.value
    .map((e) => {
      const d = e.rec.data as Record<string, unknown>;
      return `${e.rec.kind}|${e.scope}|${d.title ?? d.name ?? d.text ?? ''}`;
    })
    .sort();

async function applied(plan: Promise<ImportPlan>) {
  const p = await plan;
  if (p.status !== 'ready') throw new Error('needs phrase');
  return { summary: p.summary, written: p.apply() };
}

describe('export and import', () => {
  it('round-trips a readable export through a wipe', async () => {
    sample();
    const before = content();
    const file = await readableExport();
    loadEntries('a', []);
    expect(visible.value).toHaveLength(0);
    const r = await applied(planImport(file));
    // The busy marker is rebuilt from its plan, not imported.
    expect(r.summary).toMatchObject({ plans: 2, lists: 2, items: 2, notes: 1 });
    expect(content()).toEqual(before);
  });

  it('round-trips an encrypted export, and only with the right phrase', async () => {
    sample();
    const before = content();
    const words = generateRecoveryPhrase();
    const file = await encryptedExport(words);
    expect(file).not.toContain('Dinner');
    expect(file).not.toContain('Groceries');
    loadEntries('a', []);
    expect(await planImport(file)).toEqual({ status: 'needs-phrase' });
    await expect(planImport(file, generateRecoveryPhrase())).rejects.toThrow(ImportError);
    await applied(planImport(file, words));
    expect(content()).toEqual(before);
  });

  it('never brings back a plan made private since, or a deleted list (review 0004, H1)', async () => {
    const { dinner, list } = sample();
    const file = await readableExport();
    setEventPrivacy(dinner, true);
    remove([list]);
    const r = await applied(planImport(file));
    expect(r.written).toBe(0);
    // Dinner exists only as the private copy; nothing shared under the old id.
    const dinners = visible.value.filter(
      (e) => e.rec.kind === 'event' && (e.rec.data as EventData).title === 'Dinner at Rosa’s',
    );
    expect(dinners).toHaveLength(1);
    expect(dinners[0]?.scope).toBe('user');
    expect(visible.value.some((e) => e.rec.kind === 'list' && e.id === list)).toBe(false);
  });

  it('moves only personal records into another space (review 0004, M2)', async () => {
    sample();
    const file = JSON.parse(await readableExport());
    file.space_id = 'another-space';
    loadEntries('a', []);
    await applied(planImport(JSON.stringify(file)));
    // Shared plans, lists and notes stay behind; private ones come along.
    expect(visible.value.every((e) => e.scope === 'user' || e.rec.kind === 'busy_stub')).toBe(true);
    expect(content()).toContain('event|user|Therapy');
    expect(content()).toContain('list|user|Gift ideas');
    expect(content().some((c) => c.includes('Dinner'))).toBe(false);
  });

  it('takes privacy from the records, not the file (review 0004, L1)', async () => {
    const therapy = createEvent(event('Therapy', { owner: 'a', privacy: 'busy' }));
    addComment(therapy, 'Bring the forms');
    const file = JSON.parse(await readableExport());
    for (const e of file.entries) if (e.kind === 'comment') e.scope = 'space'; // tampered
    loadEntries('a', []);
    await applied(planImport(JSON.stringify(file)));
    const note = visible.value.find((e) => e.rec.kind === 'comment');
    expect(note?.scope).toBe('user');
    expect(
      store.value.entries.filter((e) => e.rec.kind === 'comment' && e.scope === 'space'),
    ).toHaveLength(0);
  });

  it('refuses files that are not exports and skips invalid records', async () => {
    await expect(planImport('nope')).rejects.toThrow(ImportError);
    await expect(planImport('{"format":"other"}')).rejects.toThrow(ImportError);
    const bad = JSON.stringify({
      format: 'ours-export',
      v: 1,
      space_id: 'demo-space',
      entries: [
        { id: 'x1', kind: 'event', scope: 'space', owner: null, updated_at: 1, data: { title: 1 } },
      ],
    });
    const r = await applied(planImport(bad));
    expect(r).toMatchObject({ written: 0, summary: { skipped: 1 } });
  });

  it('exports plans as iCalendar that reads back', () => {
    sample();
    const cal = parseIcs(calendarExport());
    expect(cal.events.map((e) => e.title).sort()).toEqual(['Dinner at Rosa’s', 'Therapy']);
  });
});
