// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEvent,
  type EventData,
  exceptionsLost,
  findEntry,
  keptExceptions,
  loadEntries,
  setBackend,
  setException,
  updateEvent,
} from './model';

const weekly: EventData = {
  title: 'Physio',
  start: '2026-11-02T08:00',
  end: '2026-11-02T09:00',
  all_day: false,
  tz: 'Europe/London',
  rrule: 'FREQ=WEEKLY',
  owner: 'a',
  status: 'confirmed',
  proposed_by: null,
  privacy: 'busy',
  location: null,
  notes: null,
  countdown: false,
  away: false,
  stub_id: null,
};

beforeEach(() => {
  setBackend({ mode: 'demo', deviceId: (s) => `test-${s}`, write: () => {} });
  loadEntries('a', []);
});

describe('one day of a repeating plan', () => {
  it('a private plan’s Busy marker follows a skipped or moved day', () => {
    const id = createEvent(weekly);
    const stub = () => {
      const e = findEntry(id);
      const sid = e?.rec.kind === 'event' ? e.rec.data.stub_id : null;
      const s = sid ? findEntry(sid) : undefined;
      return s?.rec.kind === 'busy_stub' ? s.rec.data : undefined;
    };
    const undo = setException(id, '2026-11-09T08:00', null);
    expect(stub()?.except).toEqual([{ at: '2026-11-09T08:00', to: null }]);
    undo();
    expect(stub()?.except).toEqual([]);
    setException(id, '2026-11-16T08:00', { start: '2026-11-17T08:00', end: '2026-11-17T09:00' });
    expect(stub()?.except?.[0]?.to?.start).toBe('2026-11-17T08:00');
  });

  it('changing the series clears its changed days; other edits keep them', () => {
    const id = createEvent({ ...weekly, privacy: 'full' });
    const data = () => {
      const e = findEntry(id);
      return e?.rec.kind === 'event' ? e.rec.data : undefined;
    };
    setException(id, '2026-11-09T08:00', null);
    updateEvent(id, { title: 'Physio (knee)' });
    expect(data()?.except).toHaveLength(1);
    updateEvent(id, { start: '2026-11-03T08:00', end: '2026-11-03T09:00' });
    expect(data()?.except).toEqual([]);
  });

  it('only repeating plans take changed days', () => {
    const id = createEvent({ ...weekly, rrule: null, privacy: 'full' });
    setException(id, '2026-11-02T08:00', null);
    const e = findEntry(id);
    expect(e?.rec.kind === 'event' && e.rec.data.except).toBeFalsy();
  });
});

describe('keptExceptions', () => {
  const skipped: EventData = {
    ...weekly,
    except: [
      { at: '2026-11-09T08:00', to: null },
      { at: '2026-11-16T08:00', to: { start: '2026-11-17T08:00', end: '2026-11-17T09:00' } },
    ],
  };

  it('keeps changed days for edits that leave the days alone', () => {
    expect(keptExceptions(skipped, { title: 'Physio (knee)', location: 'Clinic' })).toBe(
      skipped.except,
    );
    expect(exceptionsLost(skipped, { notes: 'Bring the band' })).toBe(0);
  });

  it('moves the days to the new time when only the time changes', () => {
    const kept = keptExceptions(skipped, { start: '2026-11-02T09:30', end: '2026-11-02T10:30' });
    expect(kept.map((x) => x.at)).toEqual(['2026-11-09T09:30', '2026-11-16T09:30']);
    // A day moved on its own keeps where it was moved to.
    expect(kept[1]?.to?.start).toBe('2026-11-17T08:00');
  });

  it('drops them when the days change, and says how many', () => {
    for (const patch of [
      { start: '2026-11-03T08:00' },
      { rrule: 'FREQ=DAILY' },
      { rrule: null },
      { all_day: true },
      { tz: 'America/New_York' },
      { tz: null },
    ] satisfies Partial<EventData>[]) {
      expect(keptExceptions(skipped, patch)).toEqual([]);
      expect(exceptionsLost(skipped, patch)).toBe(2);
    }
  });

  it('has nothing to lose without changed days', () => {
    expect(keptExceptions(weekly, { rrule: null })).toEqual([]);
    expect(exceptionsLost(weekly, { rrule: null })).toBe(0);
  });
});
