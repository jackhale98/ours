// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guards review 0003 H1 on the client: reminders (including for private
 * plans) are sealed with the person's own key for themselves only, never
 * with the shared space key the partner holds.
 */
import { fromBase64Url, generateKey, KeyRing, openNotification } from '@ours/core/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEvent, loadEntries, put, setBackend, update } from '../app/model';
import { plannedReminders, reminderItems } from './notify';

const SPACE = 'space-1';
const SAM = 'user-sam';
const ALEX = 'user-alex';

function ring() {
  const r = new KeyRing(SAM);
  r.addPersonalKey({ version: 1, key: generateKey() });
  r.addSpaceKey(SPACE, { version: 1, key: generateKey() });
  return r;
}

beforeEach(() => {
  setBackend({ mode: 'demo', deviceId: (s) => `test-${s}`, write: () => {} });
  loadEntries('a', []);
});

describe('reminders', () => {
  it('are sealed with the personal key, for this person, even for private plans', () => {
    const start = new Date(Date.now() + 2 * 86_400_000);
    const day = start.toISOString().slice(0, 10);
    createEvent({
      title: 'Therapy',
      start: `${day}T17:00`,
      end: `${day}T18:00`,
      all_day: false,
      tz: 'UTC',
      rrule: null,
      away: false,
      owner: 'a',
      status: 'confirmed',
      proposed_by: null,
      privacy: 'busy',
      location: null,
      notes: null,
      countdown: false,
      stub_id: null,
      remind: { a: 60, b: null },
    });
    const planned = plannedReminders();
    expect(planned).toHaveLength(1);
    const r = ring();
    const items = reminderItems(
      { ring: r, spaceId: SPACE, userId: SAM, partnerId: () => ALEX },
      planned,
    );
    expect(items).toHaveLength(1);
    const item = items[0];
    if (!item) throw new Error('no item');
    const sealed = {
      nonce: fromBase64Url(item.payload.nonce),
      ciphertext: fromBase64Url(item.payload.ciphertext),
    };
    const at = item.fire_at;
    // Opens only as a personal reminder for Sam.
    const opened = openNotification(
      r.personalKey(1),
      { space_id: SPACE, scope: 'user', recipient: SAM },
      item.key_version,
      sealed,
      at,
      () => false,
    );
    expect(opened.status).toBe('show');
    // Not with the space key (the partner has it), and not for Alex.
    expect(() =>
      openNotification(
        r.spaceKey(SPACE, 1),
        { space_id: SPACE, scope: 'space', recipient: SAM },
        1,
        sealed,
        at,
        () => false,
      ),
    ).toThrow();
    expect(() =>
      openNotification(
        r.personalKey(1),
        { space_id: SPACE, scope: 'user', recipient: ALEX },
        1,
        sealed,
        at,
        () => false,
      ),
    ).toThrow();
  });
});

describe('several reminders per plan', () => {
  it('plans one push per reminder, with all-day offsets counted from 9 AM', () => {
    const now = Date.now();
    const day = new Date(now + 3 * 86_400_000).toISOString().slice(0, 10);
    createEvent({
      title: 'Dinner',
      start: `${day}T19:00`,
      end: `${day}T21:00`,
      all_day: false,
      tz: 'UTC',
      rrule: null,
      away: false,
      owner: 'both',
      status: 'confirmed',
      proposed_by: null,
      privacy: 'full',
      location: 'Vic’s',
      notes: null,
      countdown: false,
      stub_id: null,
      remind: { a: [15, 60, 1440], b: null },
    });
    createEvent({
      title: 'Lisbon trip',
      start: day,
      end: new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10),
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
      countdown: true,
      stub_id: null,
      remind: { a: [900], b: null },
    });
    const planned = plannedReminders(now);
    const dinner = planned.filter((p) => p.title === 'Dinner');
    expect(dinner).toHaveLength(3);
    expect(dinner.map((p) => p.body)).toEqual([
      'In 1 day · 7 PM · Vic’s',
      'In 1 hour · 7 PM · Vic’s',
      'In 15 minutes · 7 PM · Vic’s',
    ]);
    const trip = planned.find((p) => p.title === 'Lisbon trip');
    // 6 PM the evening before, in the viewer's zone.
    expect(new Date(trip?.fire_at ?? 0).toISOString().slice(11, 16)).toBe(
      new Date(Date.parse(`${day}T09:00:00`) - 15 * 3_600_000).toISOString().slice(11, 16),
    );
    expect(trip?.body).toMatch(/^Tomorrow · /);
  });

  it('remind whoever’s on a chore, at its time or from 9 AM on the day', () => {
    const now = Date.now();
    const day = new Date(now + 2 * 86_400_000).toISOString().slice(0, 10);
    const home = put('list', { name: 'Home', kind: 'chores', private: false }, { scope: 'space' });
    const chore = (text: string, extra: Record<string, unknown>) =>
      put(
        'item',
        {
          list_id: home,
          text,
          done: false,
          assignee: null,
          due: day,
          sort_key: 'V',
          ...extra,
        },
        { scope: 'space' },
      );
    chore('Bins', { time: '19:00', reminders: [15, 0], assignee: 'a' });
    chore('Water the plants', { reminders: [0] }); // nobody on it: both of us
    chore('Hoover', { time: '10:00', reminders: [30], assignee: 'b' }); // Alex's
    const done = chore('Recycling', { time: '08:00', reminders: [0], assignee: 'a' });
    update<'item'>(done, { done: true });
    chore('No reminder', { time: '08:00', assignee: 'a' });

    const planned = plannedReminders(now).filter((p) => p.record_id !== '');
    const titles = planned.map((p) => p.title);
    expect(titles).toContain('Bins');
    expect(titles).toContain('Water the plants');
    expect(titles).not.toContain('Hoover');
    expect(titles).not.toContain('Recycling');
    expect(titles).not.toContain('No reminder');
    const bins = planned.filter((p) => p.title === 'Bins');
    expect(bins.map((p) => p.body)).toEqual([
      'Due in 15 minutes · 7 PM · Home',
      'Due now · 7 PM · Home',
    ]);
    expect(bins[1]?.fire_at).toBe(Date.parse(`${day}T19:00:00`));
    const plants = planned.find((p) => p.title === 'Water the plants');
    expect(plants?.body).toBe('Due today · Home');
    expect(plants?.fire_at).toBe(Date.parse(`${day}T09:00:00`));
  });

  it('chores on archived, saved or plan lists, or past, don’t remind; duplicates count once', () => {
    const now = Date.now();
    const day = new Date(now + 2 * 86_400_000).toISOString().slice(0, 10);
    const past = new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);
    const mk = (extra: Record<string, unknown>) =>
      put('list', { name: 'L', kind: 'chores', private: false, ...extra }, { scope: 'space' });
    const chore = (list: string, text: string, extra: Record<string, unknown> = {}) =>
      put(
        'item',
        {
          list_id: list,
          text,
          done: false,
          assignee: null,
          due: day,
          sort_key: 'V',
          reminders: [0, 0],
          ...extra,
        },
        { scope: 'space' },
      );
    chore(mk({}), 'Kept');
    chore(mk({ archived: true }), 'Archived');
    chore(mk({ stash: true }), 'Saved');
    chore(mk({}), 'Gone by', { due: past });
    chore(mk({ features: ['tick'] }), 'No dates here');
    // "Later that day": 6 PM on the day, without a time.
    chore(mk({}), 'Evening', { reminders: [-540] });
    const planned = plannedReminders(now);
    expect(planned.filter((p) => p.title === 'Kept')).toHaveLength(1);
    for (const t of ['Archived', 'Saved', 'Gone by', 'No dates here'])
      expect(planned.map((p) => p.title)).not.toContain(t);
    expect(planned.find((p) => p.title === 'Evening')?.fire_at).toBe(Date.parse(`${day}T18:00:00`));
  });
});
