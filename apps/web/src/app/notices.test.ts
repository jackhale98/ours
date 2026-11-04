// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
vi.mock('../account/notify', () => ({ notifyPartner: (n: unknown) => sent.push(n) }));

const { createEvent, loadEntries, put, setBackend } = await import('./model');
const { noticeNote } = await import('./notices');

const plan = () =>
  createEvent({
    title: 'Dinner',
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
    location: null,
    notes: null,
    countdown: false,
    stub_id: null,
  });

beforeEach(() => {
  sent.length = 0;
  setBackend({ mode: 'demo', deviceId: (s) => `test-${s}`, write: () => {} });
  loadEntries('a', []);
});

describe('notes notify the partner unless they turned that off', () => {
  it('sends by default', () => {
    noticeNote(plan(), 'Booked for 7');
    expect(sent).toHaveLength(1);
  });

  it('sends nothing when the partner chose not to hear about notes', () => {
    put('settings', { week_start: 1, notify_notes: { b: false } });
    noticeNote(plan(), 'Booked for 7');
    expect(sent).toHaveLength(0);
  });

  it('only the partner’s own choice counts', () => {
    put('settings', { week_start: 1, notify_notes: { a: false } });
    noticeNote(plan(), 'Booked for 7');
    expect(sent).toHaveLength(1);
  });
});
