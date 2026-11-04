// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseIcs } from '@ours/core/ics';
import type { EventData } from '@ours/core/schema';
import { describe, expect, it } from 'vitest';
import { androidIntent, eventFor, icsFor, platform } from './addtocal';

const plan = (extra: Partial<EventData> = {}): EventData => ({
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
  ...extra,
});

const read = (ics: string) => parseIcs(ics).events;

describe('add to my calendar', () => {
  it('writes time and title only by default', () => {
    const ics = icsFor(eventFor('p1', plan(), { detail: 'title', day: null, now: 0 }));
    const [ev] = read(ics);
    expect(ev).toMatchObject({ title: 'Dinner at Rosa’s', start: '2026-11-06T19:00' });
    expect(ev?.tz).toBe('Europe/London');
    expect(ics).not.toContain('Hackney');
    expect(ics).not.toContain('Book a table');
  });

  it('adds the place and notes for full details, and nothing but the time for Busy', () => {
    const full = icsFor(eventFor('p1', plan(), { detail: 'full', day: null, now: 0 }));
    expect(read(full)[0]).toMatchObject({ location: 'Rosa’s, Hackney' });
    expect(full).toContain('Book a table');
    const busy = icsFor(eventFor('p1', plan(), { detail: 'busy', day: null, now: 0 }));
    expect(read(busy)[0]?.title).toBe('Busy');
    for (const secret of ['Rosa', 'Hackney', 'Book']) expect(busy).not.toContain(secret);
  });

  it('writes one day of a series on its own, or the whole series with its changed days', () => {
    const weekly = plan({
      rrule: 'FREQ=WEEKLY',
      except: [
        { at: '2026-11-13T19:00', to: null },
        { at: '2026-11-20T19:00', to: { start: '2026-11-21T18:00', end: '2026-11-21T20:00' } },
      ],
    });
    const moved = eventFor('p1', weekly, { detail: 'title', day: '2026-11-20T19:00', now: 0 });
    expect(moved).toMatchObject({ start: '2026-11-21T18:00', rrule: null, except: [] });
    expect(moved.uid).not.toBe('p1');
    const all = eventFor('p1', weekly, { detail: 'title', day: null, now: 0 });
    expect(all.rrule).toBe('FREQ=WEEKLY');
    expect(icsFor(all)).toContain('EXDATE');
  });

  it('opens Android’s new-event screen with the details filled in', () => {
    const intent = androidIntent(eventFor('p1', plan(), { detail: 'full', day: null, now: 0 }));
    expect(intent).toMatch(/^intent:#Intent;action=android\.intent\.action\.INSERT;/);
    expect(intent).toContain(`l.beginTime=${Date.UTC(2026, 10, 6, 19, 0)}`);
    expect(intent).toContain(`S.eventLocation=${encodeURIComponent('Rosa’s, Hackney')}`);
    expect(intent).toMatch(/;end$/);
    // Nothing can break out of an extra.
    const tricky = androidIntent(
      eventFor('p1', plan({ title: 'a;end;S.x=1' }), { detail: 'title', day: null, now: 0 }),
    );
    expect(tricky).toContain('S.title=a%3Bend%3BS.x%3D1;');
  });

  it('puts all-day plans at UTC midnight, and falls back to a file for changed series', () => {
    const day = plan({ all_day: true, tz: null, start: '2026-12-24', end: '2026-12-26' });
    const intent = androidIntent(eventFor('p1', day, { detail: 'title', day: null, now: 0 }));
    expect(intent).toContain(`l.beginTime=${Date.UTC(2026, 11, 24)}`);
    expect(intent).toContain('B.allDay=true');
    const changed = plan({ rrule: 'FREQ=WEEKLY', except: [{ at: '2026-11-13T19:00', to: null }] });
    expect(androidIntent(eventFor('p1', changed, { detail: 'title', day: null, now: 0 }))).toBe(
      null,
    );
  });

  it('tells phones apart', () => {
    expect(platform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe('ios');
    expect(platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios'); // iPad
    expect(platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('other');
    expect(platform('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 5)).toBe('android');
  });
});
