// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { utf8 } from '../crypto/bytes';
import {
  CURRENT_SCHEMA,
  type DecodedRecord,
  decodeRecord,
  type EventData,
  encodeRecord,
  isTimeZone,
  MIGRATIONS,
  RecordError,
} from './records';

const meta = { updated_at: 1000, device_id: 'dev1' };

const event: EventData = {
  title: 'Dinner at Luigi’s',
  start: '2026-11-06T19:00',
  end: '2026-11-06T21:00',
  all_day: false,
  tz: 'Europe/London',
  rrule: null,
  owner: 'both',
  status: 'proposed',
  proposed_by: 'a',
  privacy: 'full',
  location: 'Luigi’s',
  notes: null,
  countdown: false,
  away: false,
  stub_id: null,
};

const samples: DecodedRecord[] = [
  { kind: 'event', deleted: false, data: event, ...meta },
  {
    kind: 'event',
    deleted: false,
    data: { ...event, all_day: true, start: '2026-12-24', end: '2026-12-27', tz: null },
    ...meta,
  },
  {
    kind: 'busy_stub',
    deleted: false,
    data: {
      start: '2026-11-07T09:00',
      end: '2026-11-07T10:00',
      all_day: false,
      tz: 'America/New_York',
      rrule: 'FREQ=WEEKLY;BYDAY=SA',
      away: false,
      owner: 'b',
    },
    ...meta,
  },
  {
    kind: 'list',
    deleted: false,
    data: { name: 'Groceries', kind: 'check', private: false },
    ...meta,
  },
  {
    kind: 'item',
    deleted: false,
    data: { list_id: 'l1', text: 'Oat milk', done: false, assignee: 'a', due: null, sort_key: 'V' },
    ...meta,
  },
  {
    kind: 'comment',
    deleted: false,
    data: { parent_id: 'e1', text: 'I’ll book', author: 'b' },
    ...meta,
  },
  {
    kind: 'checkin',
    deleted: false,
    data: { date: '2026-11-08', author: 'a', steps_done: ['week', 'chores'], note: null },
    ...meta,
  },
  {
    kind: 'settings',
    deleted: false,
    data: {
      week_start: 1,
      quiet_hours: { start: '22:00', end: '07:30' },
      members: { a: { name: 'Sam', color: '#d0603a', user_id: 'u1' } },
    },
    ...meta,
  },
  { kind: 'item', deleted: true, data: null, ...meta },
];

describe('record encode/decode', () => {
  it.each(samples.map((s) => [s.kind, s] as const))('round-trips %s', (_kind, record) => {
    expect(decodeRecord(encodeRecord(record))).toEqual({ ok: true, record });
  });

  it('stamps the current schema version', () => {
    const json = JSON.parse(new TextDecoder().decode(encodeRecord(samples[0] as DecodedRecord)));
    expect(json.schema).toBe(CURRENT_SCHEMA.event);
  });

  it.each<[string, Partial<EventData>]>([
    ['empty title', { title: '   ' }],
    ['end before start', { end: '2026-11-06T18:00' }],
    ['timed without tz', { tz: null }],
    ['unknown tz', { tz: 'Mars/Olympus' }],
    ['all-day with times', { all_day: true }],
    ['bad owner', { owner: 'c' as never }],
    ['bad date', { start: '2026-13-06T19:00' as never }],
  ])('refuses to encode an event with %s', (_name, patch) => {
    expect(() =>
      encodeRecord({ kind: 'event', deleted: false, data: { ...event, ...patch }, ...meta }),
    ).toThrow();
  });

  it('rejects an all-day event that ends on its start day', () => {
    expect(() =>
      encodeRecord({
        kind: 'event',
        deleted: false,
        data: { ...event, all_day: true, start: '2026-12-24', end: '2026-12-24', tz: null },
        ...meta,
      }),
    ).toThrow();
  });

  it.each([
    ['not JSON', 'nope'],
    [
      'unknown kind',
      JSON.stringify({ kind: 'photo', schema: 1, ...meta, deleted: false, data: {} }),
    ],
    [
      'bad data',
      JSON.stringify({ kind: 'list', schema: 1, ...meta, deleted: false, data: { name: 3 } }),
    ],
    ['missing meta', JSON.stringify({ kind: 'list', schema: 1, deleted: false, data: {} })],
  ])('reports %s as invalid', (_name, text) => {
    expect(decodeRecord(utf8(text))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reports newer schemas without parsing them', () => {
    const text = JSON.stringify({
      kind: 'list',
      schema: 99,
      ...meta,
      deleted: false,
      data: { x: 1 },
    });
    expect(decodeRecord(utf8(text))).toEqual({ ok: false, reason: 'newer-schema' });
  });

  it('rejects absurd timestamps that would freeze a record', () => {
    expect(() => encodeRecord({ ...(samples[3] as DecodedRecord), updated_at: 1e300 })).toThrow(
      RecordError,
    );
    const text = JSON.stringify({
      kind: 'list',
      schema: 1,
      updated_at: 2 ** 49,
      device_id: 'd',
      deleted: false,
      data: { name: 'x', kind: 'check', private: false },
    });
    expect(decodeRecord(utf8(text))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never puts plaintext in validation errors', () => {
    try {
      encodeRecord({
        kind: 'list',
        deleted: false,
        data: { name: 'x', kind: 'SECRET' as never, private: false },
        ...meta,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RecordError);
      expect(String(e)).not.toContain('SECRET');
      expect(JSON.stringify(e)).not.toContain('SECRET');
      expect((e as RecordError).paths).toEqual(['kind']);
    }
  });

  it('accepts all real IANA zones and rejects junk', () => {
    expect(isTimeZone('Pacific/Auckland')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Not/AZone')).toBe(false);
  });
});

describe('migrations', () => {
  const original = CURRENT_SCHEMA.list;
  afterEach(() => {
    CURRENT_SCHEMA.list = original;
    delete MIGRATIONS.list;
  });

  it('upgrades old records step by step', () => {
    CURRENT_SCHEMA.list = 3;
    MIGRATIONS.list = {
      1: (d) => ({ ...d, title: undefined, name: d.title }),
      2: (d) => ({ name: d.name, kind: 'check', private: false }),
    };
    const old = JSON.stringify({
      kind: 'list',
      schema: 1,
      ...meta,
      deleted: false,
      data: { title: 'Trip' },
    });
    expect(decodeRecord(utf8(old))).toEqual({
      ok: true,
      record: {
        kind: 'list',
        deleted: false,
        data: { name: 'Trip', kind: 'check', private: false },
        ...meta,
      },
    });
  });

  it('fails cleanly when a migration step is missing', () => {
    CURRENT_SCHEMA.list = 2;
    const old = JSON.stringify({
      kind: 'list',
      schema: 1,
      ...meta,
      deleted: false,
      data: { name: 'x' },
    });
    expect(decodeRecord(utf8(old))).toEqual({ ok: false, reason: 'invalid' });
  });
});
