// SPDX-License-Identifier: AGPL-3.0-or-later
import { toInstant } from '@ours/core/time';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEvent, type EventData, loadEntries, setBackend } from './model';
import { agendaFrom, clashText, conflictsFor, now, routineWhileAway, zone } from './select';

const plan = (p: Partial<EventData>): EventData => ({
  title: 'Plan',
  start: '2026-11-06T19:00',
  end: '2026-11-06T21:00',
  all_day: false,
  tz: zone,
  rrule: null,
  away: false,
  owner: 'a',
  status: 'confirmed',
  proposed_by: null,
  privacy: 'full',
  location: null,
  notes: null,
  countdown: false,
  stub_id: null,
  ...p,
});

beforeEach(() => {
  setBackend({ mode: 'demo', deviceId: (s) => `test-${s}`, write: () => {} });
  loadEntries('a', []);
  now.value = Date.parse('2026-11-03T12:00:00Z');
});

describe('conflicts (review 0009, P-3)', () => {
  const at = (w: string) => toInstant(w, zone);

  it('finds what a new plan would overlap, for the same person only', () => {
    createEvent(plan({ title: 'Book club' }));
    createEvent(plan({ title: 'Climbing', owner: 'b' }));
    const mine = conflictsFor(at('2026-11-06T20:00'), at('2026-11-06T22:00'), 'a');
    expect(mine.map((r) => r.title)).toEqual(['Book club']);
    const ours = conflictsFor(at('2026-11-06T20:00'), at('2026-11-06T22:00'), 'both');
    expect(ours.map((r) => r.title).sort()).toEqual(['Book club', 'Climbing']);
    expect(conflictsFor(at('2026-11-06T21:00'), at('2026-11-06T22:00'), 'a')).toEqual([]);
    expect(clashText(mine, { me: 'a', partner: 'Alex' })).toBe('Overlaps Book club (yours)');
    expect(
      clashText(
        ours.filter((r) => r.owner === 'b'),
        { me: 'a', partner: 'Alex' },
      ),
    ).toBe('Overlaps Climbing (Alex’s)');
  });

  it('leaves out the plan itself, and plans marked declined', () => {
    const id = createEvent(plan({ title: 'Dinner' }));
    createEvent(plan({ title: 'No', status: 'declined', proposed_by: 'a' }));
    expect(conflictsFor(at('2026-11-06T19:00'), at('2026-11-06T20:00'), 'a', id)).toEqual([]);
  });

  it('marks overlapping rows on the day, and routines while away', () => {
    createEvent(plan({ title: 'Book club' }));
    createEvent(plan({ title: 'Drinks', start: '2026-11-06T20:00', end: '2026-11-06T22:00' }));
    createEvent(
      plan({
        title: 'Gym',
        owner: 'b',
        start: '2026-11-06T07:00',
        end: '2026-11-06T08:00',
        rrule: 'FREQ=DAILY',
      }),
    );
    createEvent(
      plan({
        title: 'Work trip',
        owner: 'b',
        all_day: true,
        away: true,
        tz: null,
        start: '2026-11-06',
        end: '2026-11-08',
      }),
    );
    const day = agendaFrom('2026-11-06', 1)[0];
    if (!day) throw new Error('no day');
    const clashing = day.rows.filter((r) => day.clash.has(r.key)).map((r) => r.title);
    expect(clashing.sort()).toEqual(['Book club', 'Drinks']);
    const gym = day.rows.find((r) => r.title === 'Gym');
    expect(gym && routineWhileAway(gym, day)).toBe(true);
    const book = day.rows.find((r) => r.title === 'Book club');
    expect(book && routineWhileAway(book, day)).toBe(false);
  });
});
