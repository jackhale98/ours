// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { call, couple, envelope, randomB64 } from './helpers';

const push = (token: string, spaceId: string, items: unknown[]) =>
  call('/sync/push', { token, body: { space_id: spaceId, items } });

describe('key rotation (ADR 0013)', () => {
  it('raises the minimum key versions by one and refuses old-key writes', async () => {
    const { sam, alex, spaceId } = await couple();
    const before = await push(sam.token, spaceId, [{ envelope: envelope(spaceId), base_rev: 0 }]);
    expect(before.json.results[0].status).toBe('ok');

    const rot = await call(`/spaces/${spaceId}/rotate`, {
      token: sam.token,
      body: { space_from: 1, personal_from: 1 },
    });
    expect(rot.status).toBe(200);
    expect(rot.json).toMatchObject({ key_version: 2, personal_key_version: 2 });
    expect(rot.json.rotated_rev).toBeGreaterThan(0);

    // /me tells every device the new minimums.
    const me = await call('/me', { token: alex.token });
    expect(me.json.spaces[0]).toMatchObject({ key_version: 2 });
    expect((await call('/me', { token: sam.token })).json.user.personal_key_version).toBe(2);

    // Old space key: refused, from either partner. New: accepted.
    const old = await push(alex.token, spaceId, [{ envelope: envelope(spaceId), base_rev: 0 }]);
    expect(old.json.results[0]).toMatchObject({ status: 'rejected', reason: 'stale_key' });
    const fresh = await push(alex.token, spaceId, [
      { envelope: { ...envelope(spaceId), key_version: 2 }, base_rev: 0 },
    ]);
    expect(fresh.json.results[0].status).toBe('ok');

    // Personal records: Sam's floor moved, Alex's didn't.
    const samOld = await push(sam.token, spaceId, [
      {
        envelope: { ...envelope(spaceId, { scope: 'user', owner: sam.userId }), key_version: 1 },
        base_rev: 0,
      },
    ]);
    expect(samOld.json.results[0].reason).toBe('stale_key');
    const alexOld = await push(alex.token, spaceId, [
      { envelope: envelope(spaceId, { scope: 'user', owner: alex.userId }), base_rev: 0 },
    ]);
    expect(alexOld.json.results[0].status).toBe('ok');

    // Notifications under the old space key are refused too.
    const note = await call('/push/notify', {
      token: alex.token,
      body: {
        space_id: spaceId,
        key_version: 1,
        to: 'partner',
        payload: { nonce: randomB64(24), ciphertext: randomB64(64) },
      },
    });
    expect(note.status).toBe(409);
  });

  it('allows exactly one step from the current versions', async () => {
    const { sam, alex, spaceId } = await couple();
    const skip = await call(`/spaces/${spaceId}/rotate`, {
      token: sam.token,
      body: { space_from: 2, personal_from: 1 },
    });
    expect(skip.status).toBe(409);
    await call(`/spaces/${spaceId}/rotate`, {
      token: sam.token,
      body: { space_from: 1, personal_from: 1 },
    });
    // Alex rotating from the same starting point loses the race.
    const late = await call(`/spaces/${spaceId}/rotate`, {
      token: alex.token,
      body: { space_from: 1, personal_from: 1 },
    });
    expect(late.status).toBe(409);
  });

  it('a key update link can only be claimed by the partner, and nobody joins', async () => {
    const { sam, alex, spaceId } = await couple();
    const wrapped = { nonce: randomB64(24), ciphertext: randomB64(120) };
    const inv = await call('/invites', {
      token: sam.token,
      body: { kind: 'rekey', space_id: spaceId, wrapped },
    });
    expect(inv.status).toBe(201);
    // Sam can't claim his own; an outsider can't either.
    expect((await call(`/invites/${inv.json.id}`, { token: sam.token })).status).toBe(404);
    const outsider = await couple();
    expect((await call(`/invites/${inv.json.id}`, { token: outsider.sam.token })).status).toBe(404);
    const got = await call(`/invites/${inv.json.id}`, { token: alex.token });
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ kind: 'rekey', space_id: spaceId, wrapped });
    const acc = await call(`/invites/${inv.json.id}/accept`, { token: alex.token, body: {} });
    expect(acc.status).toBe(200);
    // Used once: gone.
    expect((await call(`/invites/${inv.json.id}`, { token: alex.token })).status).toBe(404);
    const me = await call('/me', { token: alex.token });
    expect(me.json.spaces[0].members).toHaveLength(2);
  });
});
