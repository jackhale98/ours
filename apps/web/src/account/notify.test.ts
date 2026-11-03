// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guards review 0003 H1 on the client: reminders (including for private
 * plans) are sealed with the person's own key for themselves only, never
 * with the shared space key the partner holds.
 */
import { fromBase64Url, generateKey, KeyRing, openNotification } from '@ours/core/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEvent, loadEntries, setBackend } from '../app/model';
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
