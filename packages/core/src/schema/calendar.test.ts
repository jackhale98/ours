// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CryptoError } from '../crypto/bytes';
import { scopeAllows, sealDecodedRecord } from '../crypto/codec';
import { generateKey, KeyRing } from '../crypto/keys';
import { type DecodedRecord, decodeRecord, encodeRecord, RecordError } from './records';

const meta = { updated_at: 1, device_id: 'd' };
const calendar: DecodedRecord = {
  kind: 'calendar',
  deleted: false,
  data: {
    name: 'Work',
    url: 'https://calendar.example/feed.ics',
    owner: 'a',
    share: 'busy',
    fetched_at: null,
  },
  ...meta,
};
const item = {
  start: '2026-11-04T09:00',
  end: '2026-11-04T10:00',
  all_day: false,
  tz: 'Europe/London',
};
const busySnap: DecodedRecord = {
  kind: 'cal_snapshot',
  deleted: false,
  data: {
    calendar_id: 'c1',
    importer: 'a',
    owner: 'a',
    detail: 'busy',
    window_start: '2026-11-03',
    window_end: '2026-12-03',
    fetched_at: 5,
    items: [item, { start: '2026-11-07', end: '2026-11-08', all_day: true, tz: null }],
  },
  ...meta,
};

describe('imported calendar records', () => {
  it('round-trip', () => {
    expect(decodeRecord(encodeRecord(calendar))).toEqual({ ok: true, record: calendar });
    expect(decodeRecord(encodeRecord(busySnap))).toEqual({ ok: true, record: busySnap });
    const full = {
      ...busySnap,
      data: {
        ...busySnap.data,
        detail: 'full',
        name: 'Work',
        items: [{ ...item, title: 'Standup', location: 'Room 4' }],
      },
    } as DecodedRecord;
    expect(decodeRecord(encodeRecord(full))).toEqual({ ok: true, record: full });
  });

  it('refuses titles, places or names in busy-only snapshots', () => {
    const leaks = [
      { ...busySnap.data, name: 'Work' },
      { ...busySnap.data, items: [{ ...item, title: 'Standup' }] },
      { ...busySnap.data, items: [{ ...item, location: 'Room 4' }] },
    ];
    for (const data of leaks) {
      expect(() => encodeRecord({ ...busySnap, data } as DecodedRecord)).toThrow(RecordError);
    }
  });

  it('refuses non-http URLs and oversized snapshots', () => {
    expect(() =>
      encodeRecord({
        ...calendar,
        data: { ...calendar.data, url: 'javascript:alert(1)' },
      } as DecodedRecord),
    ).toThrow();
    const many = Array.from({ length: 401 }, () => item);
    expect(() =>
      encodeRecord({ ...busySnap, data: { ...busySnap.data, items: many } } as DecodedRecord),
    ).toThrow();
  });

  it('never stores a calendar source (and its secret URL) under the shared key', () => {
    expect(scopeAllows(calendar, 'space')).toBe(false);
    expect(scopeAllows(calendar, 'user')).toBe(true);
    const ring = new KeyRing('u');
    ring.addPersonalKey({ version: 1, key: generateKey() });
    ring.addSpaceKey('s', { version: 1, key: generateKey() });
    const id = '0190a6c8-7a3e-7cc2-9b1d-3f6e2a1b4c5d';
    expect(() => sealDecodedRecord(ring, { id, space_id: 's', scope: 'space' }, calendar)).toThrow(
      CryptoError,
    );
    expect(
      sealDecodedRecord(ring, { id, space_id: 's', scope: 'user' }, calendar).header.scope,
    ).toBe('user');
    expect(scopeAllows(busySnap, 'space')).toBe(true);
  });
});
