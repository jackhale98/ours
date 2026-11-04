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
  return { summary: p.summary, written: await p.apply() };
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

  it('waits for a full sync, and checks again when applying (review 0004, condition A)', async () => {
    const { dinner } = sample();
    const file = await readableExport();
    loadEntries('a', []);
    // A new device: the first pull hasn't finished, so the deletion of the
    // shared dinner (made private since) isn't known here yet.
    let caught = false;
    const known = new Set<string>();
    setBackend({
      mode: 'demo',
      deviceId: (s) => `test-${s}`,
      write: () => {},
      knownIds: async () => new Set(known),
      caughtUp: () => caught,
    });
    await expect(planImport(file)).rejects.toThrow(/Finish syncing first/);
    caught = true;
    const plan = await planImport(file);
    if (plan.status !== 'ready') throw new Error('needs phrase');
    expect(plan.summary.plans).toBe(2);
    // The pull then brings the tombstone before the import is confirmed...
    known.add(dinner);
    const written = await plan.apply();
    expect(content().some((c) => c.includes('Dinner'))).toBe(false);
    expect(written).toBeGreaterThan(0);
    // ...and a sync that fails afterwards stops the import again.
    loadEntries('a', []);
    const again = await planImport(file);
    caught = false;
    if (again.status !== 'ready') throw new Error('needs phrase');
    await expect(again.apply()).rejects.toThrow(/Finish syncing first/);
    expect(visible.value).toHaveLength(0);
  });

  it('decides shared or not from the records, so a relabelled file can’t cross spaces (R3)', async () => {
    sample();
    const file = JSON.parse(await readableExport());
    file.space_id = 'another-space';
    for (const e of file.entries) e.scope = 'user'; // tampered: everything "personal"
    loadEntries('a', []);
    await applied(planImport(JSON.stringify(file)));
    expect(content().some((c) => c.includes('Dinner'))).toBe(false);
    expect(content().some((c) => c.includes('Groceries') || c.includes('Oat milk'))).toBe(false);
    expect(content()).toContain('event|user|Therapy');
    expect(content()).toContain('item|user|Scarf');
    expect(visible.value.every((e) => e.scope === 'user' || e.rec.kind === 'busy_stub')).toBe(true);
  });

  it('can’t slip items into a shared list here with a decoy of it (re-check N4)', async () => {
    const shared = put('list', { name: 'Groceries', kind: 'shopping', private: false });
    const file = {
      format: 'ours-export',
      v: 1,
      space_id: 'another-space',
      entries: [
        // A "private" copy of the shared list's id, then an item for it.
        {
          id: shared,
          kind: 'list',
          scope: 'user',
          owner: 'a',
          updated_at: 1,
          data: { name: 'Groceries', kind: 'shopping', private: true },
        },
        {
          id: 'item-1',
          kind: 'item',
          scope: 'user',
          owner: 'a',
          updated_at: 1,
          data: {
            list_id: shared,
            text: 'From the old space',
            done: false,
            assignee: null,
            due: null,
            sort_key: 'm',
          },
        },
      ],
    };
    await applied(planImport(JSON.stringify(file)));
    expect(content().some((c) => c.includes('From the old space'))).toBe(false);
  });

  it('never writes a child whose parent wasn’t written (R4)', async () => {
    const therapy = createEvent(event('Therapy', { owner: 'a', privacy: 'busy' }));
    addComment(therapy, 'Bring the forms');
    const file = JSON.parse(await readableExport());
    // A reply to the note, and the note itself made invalid so it's dropped.
    const note = file.entries.find((e: { kind: string }) => e.kind === 'comment');
    const first = note.id;
    file.entries.push({ ...note, id: 'reply-1', data: { ...note.data, parent_id: first } });
    note.data = { body: 42 };
    loadEntries('a', []);
    await applied(planImport(JSON.stringify(file)));
    expect(store.value.entries.filter((e) => e.rec.kind === 'comment')).toHaveLength(0);
  });

  it('restores replies to notes in any order', async () => {
    const dinner = createEvent(event('Dinner'));
    addComment(dinner, 'Booked for 7');
    const file = JSON.parse(await readableExport());
    const note = file.entries.find((e: { kind: string }) => e.kind === 'comment');
    const first = note.id;
    // The reply comes first in the file.
    file.entries.unshift({ ...note, id: 'reply-1', data: { ...note.data, parent_id: first } });
    loadEntries('a', []);
    await applied(planImport(JSON.stringify(file)));
    const notes = store.value.entries.filter((e) => e.rec.kind === 'comment');
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.scope === 'space')).toBe(true);
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
