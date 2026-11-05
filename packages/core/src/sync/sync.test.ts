// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../crypto/bytes';
import { uuidv7 } from '../schema/ids';
import type { DecodedRecord, ItemData, ListData } from '../schema/records';
import { compareWrites, nextTimestamp } from './clock';
import { mergeRecord } from './merge';
import { PullQuery, PushRequest } from './protocol';

const writer = { now: 5000, device_id: 'dev-me' };

const item = (data: Partial<ItemData>, updated_at: number, device_id: string): DecodedRecord => ({
  kind: 'item',
  deleted: false,
  data: {
    list_id: 'l1',
    text: 'Milk',
    done: false,
    assignee: null,
    due: null,
    sort_key: 'V',
    ...data,
  },
  updated_at,
  device_id,
});

const event = (title: string, updated_at: number, device_id: string): DecodedRecord => ({
  kind: 'event',
  deleted: false,
  data: {
    title,
    start: '2026-11-06T19:00',
    end: '2026-11-06T20:00',
    all_day: false,
    tz: 'UTC',
    rrule: null,
    owner: 'a',
    status: 'confirmed',
    proposed_by: null,
    privacy: 'full',
    location: null,
    notes: null,
    countdown: false,
    away: false,
    stub_id: null,
  },
  updated_at,
  device_id,
});

describe('clock', () => {
  it('never goes backwards relative to what was seen', () => {
    expect(nextTimestamp(100, undefined)).toBe(100);
    expect(nextTimestamp(100, 50)).toBe(100);
    expect(nextTimestamp(100, 200)).toBe(201);
    expect(nextTimestamp(100.9, 100)).toBe(101);
  });

  it('orders by time then device', () => {
    expect(
      compareWrites({ updated_at: 1, device_id: 'b' }, { updated_at: 2, device_id: 'a' }),
    ).toBe(-1);
    expect(
      compareWrites({ updated_at: 2, device_id: 'a' }, { updated_at: 2, device_id: 'b' }),
    ).toBe(-1);
    expect(
      compareWrites({ updated_at: 2, device_id: 'b' }, { updated_at: 2, device_id: 'a' }),
    ).toBe(1);
    expect(
      compareWrites({ updated_at: 2, device_id: 'a' }, { updated_at: 2, device_id: 'a' }),
    ).toBe(0);
  });
});

describe('mergeRecord', () => {
  it('takes remote when there is no local copy', () => {
    const remote = event('A', 1, 'x');
    expect(mergeRecord(undefined, undefined, remote, false, writer)).toEqual({
      action: 'take-remote',
      record: remote,
    });
  });

  it('takes a newer remote when nothing is pending', () => {
    const local = event('old', 1, 'x');
    const remote = event('new', 2, 'y');
    expect(mergeRecord(local, local, remote, false, writer).action).toBe('take-remote');
  });

  it('keeps local and re-pushes when the server replays an older version', () => {
    const local = event('newest', 10, 'x');
    const replay = event('stale', 3, 'x');
    expect(mergeRecord(local, local, replay, false, writer)).toEqual({
      action: 'keep-local',
      record: local,
    });
  });

  it('treats an identical write as already synced', () => {
    const r = event('same', 4, 'x');
    expect(mergeRecord(r, r, r, true, writer).action).toBe('take-remote');
  });

  it('uses last-writer-wins for events with pending edits', () => {
    const base = event('base', 1, 'x');
    const local = event('mine', 3, 'me');
    const remote = event('theirs', 2, 'them');
    expect(mergeRecord(base, local, remote, true, writer)).toEqual({
      action: 'keep-local',
      record: local,
    });
    const laterRemote = event('theirs', 4, 'them');
    expect(mergeRecord(base, local, laterRemote, true, writer)).toEqual({
      action: 'take-remote',
      record: laterRemote,
    });
  });

  it('merges items field by field when different fields changed', () => {
    const base = item({}, 1, 'x');
    const local = item({ done: true }, 3, 'me');
    const remote = item({ text: 'Oat milk' }, 2, 'them');
    const out = mergeRecord(base, local, remote, true, writer);
    expect(out.action).toBe('merged');
    expect(out.record.data).toMatchObject({ done: true, text: 'Oat milk' });
    expect(out.record.updated_at).toBe(5000);
    expect(out.record.device_id).toBe('dev-me');
  });

  it('merges lists field by field: a rename on one phone and a pin on the other', () => {
    const list = (
      data: Partial<ListData>,
      updated_at: number,
      device_id: string,
    ): DecodedRecord => ({
      kind: 'list',
      deleted: false,
      data: { name: 'Groceries', kind: 'shopping', private: false, ...data },
      updated_at,
      device_id,
    });
    const base = list({ sections: ['Produce'] }, 1, 'x');
    const local = list({ sections: ['Produce'], pinned: true }, 3, 'me');
    const remote = list({ sections: ['Produce', 'Dairy'], name: 'Big shop' }, 2, 'them');
    const out = mergeRecord(base, local, remote, true, writer);
    expect(out.action).toBe('merged');
    expect(out.record.data).toMatchObject({
      name: 'Big shop',
      pinned: true,
      sections: ['Produce', 'Dairy'],
    });
  });

  it('keeps a deleted list deleted when the other side only moved or pinned it', () => {
    const list = (
      data: Partial<ListData>,
      updated_at: number,
      device_id: string,
    ): DecodedRecord => ({
      kind: 'list',
      deleted: false,
      data: { name: 'Gifts', kind: 'gifts', private: false, ...data },
      updated_at,
      device_id,
    });
    const gone = (updated_at: number, device_id: string): DecodedRecord => ({
      kind: 'list',
      deleted: true,
      data: null,
      updated_at,
      device_id,
    });
    const base = list({}, 1, 'x');
    // Deleted here first; the other phone's later reorder doesn't bring it back.
    expect(
      mergeRecord(
        base,
        list({ sort_key: 'V', pinned: true }, 3, 'me'),
        gone(2, 'them'),
        true,
        writer,
      ).action,
    ).toBe('take-remote');
    expect(
      mergeRecord(base, gone(2, 'me'), list({ sort_key: 'V' }, 3, 'them'), true, writer).action,
    ).toBe('keep-local');
    // A real edit (a rename) that is later still wins, as before.
    expect(
      mergeRecord(base, gone(2, 'me'), list({ name: 'Presents' }, 3, 'them'), true, writer).action,
    ).toBe('take-remote');
  });

  it('stamps merged results after both inputs even with a slow clock', () => {
    const base = item({}, 1, 'x');
    const out = mergeRecord(
      base,
      item({ done: true }, 9000, 'me'),
      item({ text: 'Oat milk' }, 9500, 'them'),
      true,
      writer,
    );
    expect(out.record.updated_at).toBe(9501);
  });

  it('lets the later writer win a field both sides changed', () => {
    const base = item({}, 1, 'x');
    const out = mergeRecord(
      base,
      item({ text: 'A', done: true }, 3, 'me'),
      item({ text: 'B' }, 4, 'them'),
      true,
      writer,
    );
    expect(out.record.data).toMatchObject({ text: 'B', done: true });
  });

  it('collapses a field merge that equals one side', () => {
    const base = item({}, 1, 'x');
    const remote = item({ text: 'B' }, 4, 'them');
    expect(mergeRecord(base, item({ text: 'B' }, 3, 'me'), remote, true, writer)).toEqual({
      action: 'take-remote',
      record: remote,
    });
    const local = item({ done: true, text: 'B' }, 3, 'me');
    expect(mergeRecord(base, local, item({ text: 'B' }, 2, 'them'), true, writer).action).toBe(
      'keep-local',
    );
  });

  it('falls back to LWW without a base or with deletions', () => {
    const local = item({ done: true }, 3, 'me');
    const remote = item({ text: 'B' }, 4, 'them');
    expect(mergeRecord(undefined, local, remote, true, writer).action).toBe('take-remote');
    const tombstone: DecodedRecord = {
      kind: 'item',
      deleted: true,
      data: null,
      updated_at: 5,
      device_id: 'them',
    };
    expect(mergeRecord(item({}, 1, 'x'), local, tombstone, true, writer)).toEqual({
      action: 'take-remote',
      record: tombstone,
    });
    const laterEdit = item({ done: true }, 6, 'me');
    expect(mergeRecord(item({}, 1, 'x'), laterEdit, tombstone, true, writer).action).toBe(
      'keep-local',
    );
  });
});

describe('plans merge field by field (review 0009, P-5)', () => {
  type EventFields = Extract<DecodedRecord, { kind: 'event' }>['data'];
  const ev = (
    patch: Partial<EventFields>,
    updated_at: number,
    device_id: string,
  ): DecodedRecord => {
    const r = event('Dinner', updated_at, device_id);
    return {
      ...r,
      data: { ...(r.data as EventFields), rrule: 'FREQ=WEEKLY', ...patch },
    } as DecodedRecord;
  };
  const data = (r: DecodedRecord) => r.data as EventFields;

  it('keeps my reminder when Alex moves the time', () => {
    const base = ev({}, 1, 'x');
    const mine = ev({ remind: { a: [30], b: [] } }, 2, 'me');
    const theirs = ev({ start: '2026-11-06T20:00', end: '2026-11-06T21:00' }, 3, 'them');
    const out = mergeRecord(base, mine, theirs, true, writer);
    expect(out.action).toBe('merged');
    expect(data(out.record)).toMatchObject({ start: '2026-11-06T20:00', remind: { a: [30] } });
  });

  it('keeps both reminders when each of us sets our own', () => {
    const base = ev({ remind: { a: [], b: [] } }, 1, 'x');
    const out = mergeRecord(
      base,
      ev({ remind: { a: [15], b: [] } }, 2, 'me'),
      ev({ remind: { a: [], b: [60] } }, 3, 'them'),
      true,
      writer,
    );
    expect(data(out.record).remind).toEqual({ a: [15], b: [60] });
  });

  it('keeps both skipped days: I skip Christmas, Alex skips New Year', () => {
    const base = ev({ except: [] }, 1, 'x');
    const out = mergeRecord(
      base,
      ev({ except: [{ at: '2026-12-25T19:00', to: null }] }, 2, 'me'),
      ev({ except: [{ at: '2027-01-01T19:00', to: null }] }, 3, 'them'),
      true,
      writer,
    );
    expect(data(out.record).except?.map((x) => x.at)).toEqual([
      '2026-12-25T19:00',
      '2027-01-01T19:00',
    ]);
  });

  it('keeps Alex’s yes and my new place', () => {
    const base = ev({ status: 'proposed', proposed_by: 'a' }, 1, 'x');
    const out = mergeRecord(
      base,
      ev({ status: 'proposed', proposed_by: 'a', location: 'Vic’s' }, 2, 'me'),
      ev({ status: 'confirmed', proposed_by: null }, 3, 'them'),
      true,
      writer,
    );
    expect(data(out.record)).toMatchObject({
      status: 'confirmed',
      proposed_by: null,
      location: 'Vic’s',
    });
  });

  it('never half-merges a time: both moved it, the later move wins whole', () => {
    const base = ev({}, 1, 'x');
    const out = mergeRecord(
      base,
      ev({ start: '2026-11-06T18:00' }, 2, 'me'),
      ev({ end: '2026-11-06T22:00' }, 3, 'them'),
      true,
      writer,
    );
    expect(data(out.record)).toMatchObject({ start: '2026-11-06T19:00', end: '2026-11-06T22:00' });
  });

  it('skipped days follow a change of time, keeping the other side’s new skips', () => {
    const base = ev({ except: [{ at: '2026-11-13T19:00', to: null }] }, 1, 'x');
    const moved = ev(
      {
        start: '2026-11-06T20:00',
        end: '2026-11-06T21:00',
        except: [{ at: '2026-11-13T20:00', to: null }],
      },
      2,
      'me',
    );
    const skipped = ev(
      {
        except: [
          { at: '2026-11-13T19:00', to: null },
          { at: '2026-11-20T19:00', to: null },
        ],
      },
      3,
      'them',
    );
    const out = mergeRecord(base, moved, skipped, true, writer);
    expect(data(out.record).start).toBe('2026-11-06T20:00');
    // Alex's new skip comes along, at the new time.
    expect(data(out.record).except).toEqual([
      { at: '2026-11-13T20:00', to: null },
      { at: '2026-11-20T20:00', to: null },
    ]);
  });
});

it('drops the other side’s skips when the days themselves change', () => {
  const r = event('Gym', 1, 'x');
  type D = Extract<DecodedRecord, { kind: 'event' }>['data'];
  const mk = (p: Partial<D>, at: number, dev: string) =>
    ({
      ...r,
      updated_at: at,
      device_id: dev,
      data: { ...(r.data as D), rrule: 'FREQ=WEEKLY', ...p },
    }) as DecodedRecord;
  const out = mergeRecord(
    mk({ except: [] }, 1, 'x'),
    mk({ rrule: 'FREQ=DAILY' }, 2, 'me'),
    mk({ except: [{ at: '2026-11-13T19:00', to: null }] }, 3, 'them'),
    true,
    writer,
  );
  expect((out.record.data as D).rrule).toBe('FREQ=DAILY');
  expect((out.record.data as D).except ?? []).toEqual([]);
});

describe('plan merge, after its review', () => {
  type D = Extract<DecodedRecord, { kind: 'event' }>['data'];
  const base0 = event('Gym', 1, 'x');
  const mk = (p: Partial<D>, at: number, dev: string) =>
    ({
      ...base0,
      updated_at: at,
      device_id: dev,
      data: { ...(base0.data as D), rrule: 'FREQ=WEEKLY', ...p },
    }) as DecodedRecord;
  const get = (r: DecodedRecord) => r.data as D;
  const both = (b: DecodedRecord, l: DecodedRecord, r: DecodedRecord) => {
    const one = mergeRecord(b, l, r, true, writer);
    const two = mergeRecord(b, r, l, true, writer);
    expect(get(one.record)).toEqual(get(two.record));
    return get(one.record);
  };

  it('a day put back on one side survives a change of length on the other', () => {
    const skip = [{ at: '2026-11-13T19:00', to: null }];
    const out = both(
      mk({ except: skip }, 1, 'x'),
      mk({ except: skip, end: '2026-11-06T21:00' }, 2, 'me'),
      mk({ except: [] }, 3, 'them'),
    );
    expect(out.end).toBe('2026-11-06T21:00');
    expect(out.except).toEqual([]);
  });

  it('a moved day turned into a skip survives a change of time', () => {
    const moved = [
      { at: '2026-11-13T19:00', to: { start: '2026-11-14T19:00', end: '2026-11-14T20:00' } },
    ];
    const out = both(
      mk({ except: moved }, 1, 'x'),
      mk(
        {
          start: '2026-11-06T20:00',
          end: '2026-11-06T21:00',
          except: [{ ...moved[0], at: '2026-11-13T20:00' }] as D['except'],
        },
        2,
        'me',
      ),
      mk({ except: [{ at: '2026-11-13T19:00', to: null }] }, 3, 'them'),
    );
    expect(out.except).toEqual([{ at: '2026-11-13T20:00', to: null }]);
  });

  it('keeps both reminders set on a plan that had none', () => {
    const out = both(
      mk({}, 1, 'x'),
      mk({ remind: { a: [30], b: null } }, 2, 'me'),
      mk({ remind: { a: null, b: [60] } }, 3, 'them'),
    );
    expect(out.remind).toEqual({ a: [30], b: [60] });
  });

  it('does not carry skips from a repeat the other side dropped', () => {
    const out = both(
      mk({ except: [] }, 1, 'x'),
      mk({ rrule: 'FREQ=DAILY', except: [{ at: '2026-11-10T19:00', to: null }] }, 2, 'them'),
      mk({ start: '2026-11-06T20:00', end: '2026-11-06T21:00' }, 3, 'me'),
    );
    expect(out.rrule).toBe('FREQ=WEEKLY');
    expect(out.except ?? []).toEqual([]);
  });

  it('keeps away with the time: an all-day trip made timed loses it', () => {
    const allDay = { all_day: true, tz: null, start: '2026-11-06', end: '2026-11-08', rrule: null };
    const out = both(
      mk(allDay, 1, 'x'),
      mk({ ...allDay, away: true }, 2, 'me'),
      mk(
        {
          ...allDay,
          all_day: false,
          tz: 'UTC',
          start: '2026-11-06T09:00',
          end: '2026-11-06T10:00',
        },
        3,
        'them',
      ),
    );
    expect(out.all_day).toBe(false);
    expect(out.away).toBe(false);
  });
});

describe('mergeRecord after review', () => {
  const settings = (
    data: Record<string, unknown>,
    updated_at: number,
    device_id: string,
  ): DecodedRecord =>
    ({ kind: 'settings', deleted: false, data, updated_at, device_id }) as DecodedRecord;
  const member = (name: string, user_id: string) => ({ name, color: '#aa3300', user_id });

  it('merges nested settings edits from both sides', () => {
    const base = settings({ members: { a: member('Sam', 'u1'), b: member('Alex', 'u2') } }, 1, 'x');
    const local = settings(
      { members: { a: member('Sammy', 'u1'), b: member('Alex', 'u2') } },
      3,
      'me',
    );
    const remote = settings(
      { members: { a: member('Sam', 'u1'), b: member('Lex', 'u2') } },
      2,
      'them',
    );
    const out = mergeRecord(base, local, remote, true, writer);
    expect(out.action).toBe('merged');
    expect(out.record.data).toEqual({
      members: { a: member('Sammy', 'u1'), b: member('Lex', 'u2') },
    });
  });

  it('ignores __proto__ keys and never pollutes prototypes', () => {
    const base = item({}, 1, 'x');
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "done": true}');
    const local = {
      ...item({}, 3, 'me'),
      data: { ...(item({}, 3, 'me').data as object), ...evil },
    } as DecodedRecord;
    const out = mergeRecord(base, local, item({ text: 'B' }, 2, 'them'), true, writer);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out.record.data)).toBe(Object.prototype);
    expect(Object.keys(out.record.data ?? {})).not.toContain('__proto__');
  });

  it('falls back to last-writer-wins when a merge would be invalid', () => {
    const base = item({}, 1, 'x');
    const local = {
      ...item({}, 3, 'me'),
      data: { ...(item({}, 3, 'me').data as object), extra: 1 },
    } as unknown as DecodedRecord;
    const remote = item({ text: 'B' }, 2, 'them');
    expect(mergeRecord(base, local, remote, true, writer)).toEqual({
      action: 'keep-local',
      record: local,
    });
    const laterRemote = item({ text: 'B' }, 9, 'them');
    expect(mergeRecord(base, local, laterRemote, true, writer).action).toBe('take-remote');
  });

  it('refuses non-finite clocks', () => {
    expect(() => nextTimestamp(Number.NaN, undefined)).toThrow(RangeError);
    expect(() => nextTimestamp(1, 1e300)).toThrow(RangeError);
  });
});

describe('protocol schemas', () => {
  const envelope = {
    id: uuidv7(),
    space_id: 's1',
    scope: 'space',
    owner_user_id: null,
    key_version: 1,
    nonce: toBase64Url(new Uint8Array(24)),
    ciphertext: toBase64Url(new Uint8Array(80)),
    deleted: false,
  };

  it('accepts a push and rejects duplicates or oversize batches', () => {
    expect(v.is(PushRequest, { space_id: 's1', items: [{ envelope, base_rev: 0 }] })).toBe(true);
    expect(
      v.is(PushRequest, {
        space_id: 's1',
        items: [
          { envelope, base_rev: 0 },
          { envelope, base_rev: 0 },
        ],
      }),
    ).toBe(false);
    expect(v.is(PushRequest, { space_id: 's1', items: [] })).toBe(false);
    expect(v.is(PushRequest, { space_id: 's2', items: [{ envelope, base_rev: 0 }] })).toBe(false);
    const many = Array.from({ length: 101 }, () => ({
      envelope: { ...envelope, id: uuidv7() },
      base_rev: 0,
    }));
    expect(v.is(PushRequest, { space_id: 's1', items: many })).toBe(false);
  });

  it('parses pull query strings with a default limit', () => {
    expect(v.parse(PullQuery, { space_id: 's1', since: '12' })).toEqual({
      space_id: 's1',
      since: 12,
      limit: 500,
    });
    expect(v.is(PullQuery, { space_id: 's1', since: '-1' })).toBe(false);
    expect(v.is(PullQuery, { space_id: 's1', since: '0', limit: '501' })).toBe(false);
  });
});
