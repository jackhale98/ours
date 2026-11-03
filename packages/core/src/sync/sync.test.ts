// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../crypto/bytes';
import { uuidv7 } from '../schema/ids';
import type { DecodedRecord, ItemData } from '../schema/records';
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
