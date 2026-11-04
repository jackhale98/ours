// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, couple, outbox, randomB64 } from './helpers';

const wrapped = () => ({ nonce: randomB64(24), ciphertext: randomB64(200) });
const addPasskey = (userId: string, id: string) =>
  env.DB.prepare(
    'INSERT INTO passkeys (id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, 0, ?)',
  )
    .bind(id, userId, new Uint8Array(8), Date.now())
    .run();
const waitForMail = async (n: number) => {
  for (let i = 0; i < 100 && outbox.length < n; i++) await new Promise((r) => setTimeout(r, 5));
};

describe('passkey unlock (ADR 0015)', () => {
  it('keeps one sealed copy per passkey, only for its owner', async () => {
    const { sam, alex } = await couple();
    const pk = `pk-sam-${Date.now()}-aaaaaaaaaa`;
    await addPasskey(sam.userId, pk);
    const w = wrapped();
    const before = outbox.length;
    expect(
      (await call(`/keys/unlock/${pk}`, { token: sam.token, method: 'PUT', body: { wrapped: w } }))
        .status,
    ).toBe(200);
    await waitForMail(before + 1);
    expect(outbox.slice(before).some((m) => /Passkey unlock is on/.test(m.subject))).toBe(true);
    // Someone else's passkey, or one that doesn't exist: refused.
    expect(
      (await call(`/keys/unlock/${pk}`, { token: alex.token, method: 'PUT', body: { wrapped: w } }))
        .status,
    ).toBe(404);
    expect((await call(`/keys/unlock/${pk}`, { token: alex.token })).status).toBe(404);
    const list = await call('/keys/unlocks', { token: sam.token });
    expect(list.json.unlocks.map((u: { passkey_id: string }) => u.passkey_id)).toEqual([pk]);
    // Fetching it (to unlock a new device) tells the owner.
    const n = outbox.length;
    const got = await call(`/keys/unlock/${pk}`, { token: sam.token });
    expect(got.json.wrapped).toEqual(w);
    await waitForMail(n + 1);
    expect(outbox.slice(n).some((m) => /unlocked with a passkey/.test(m.subject))).toBe(true);
  });

  it('goes with the passkey, and with a change of keys', async () => {
    const { sam, spaceId } = await couple();
    const a = `pk-a-${Date.now()}-aaaaaaaaaa`;
    const b = `pk-b-${Date.now()}-bbbbbbbbbb`;
    await addPasskey(sam.userId, a);
    await addPasskey(sam.userId, b);
    for (const id of [a, b])
      await call(`/keys/unlock/${id}`, {
        token: sam.token,
        method: 'PUT',
        body: { wrapped: wrapped() },
      });
    await call(`/auth/passkeys/${a}`, { token: sam.token, method: 'DELETE' });
    const after = await call('/keys/unlocks', { token: sam.token });
    expect(after.json.unlocks.map((u: { passkey_id: string }) => u.passkey_id)).toEqual([b]);
    // Changing keys drops them all: a lost phone's synced passkey can't unlock the new ones.
    await env.DB.prepare('UPDATE sessions SET reauth_at = ? WHERE user_id = ?')
      .bind(Date.now(), sam.userId)
      .run();
    const rot = await call(`/spaces/${spaceId}/rotate`, {
      token: sam.token,
      body: {
        space_from: 1,
        personal_from: 1,
        space_kid: randomB64(16),
        personal_kid: randomB64(16),
      },
    });
    expect(rot.status).toBe(200);
    expect((await call('/keys/unlocks', { token: sam.token })).json.unlocks).toEqual([]);
  });
});

describe('passkey unlock switch', () => {
  it('refuses setting it up when switched off, and says so in /me', async () => {
    const { sam } = await couple();
    const pk = `pk-off-${Date.now()}-aaaaaaaaaa`;
    await addPasskey(sam.userId, pk);
    const e = env as unknown as { PASSKEY_UNLOCK?: string };
    const before = e.PASSKEY_UNLOCK;
    e.PASSKEY_UNLOCK = 'off';
    try {
      const res = await call(`/keys/unlock/${pk}`, {
        token: sam.token,
        method: 'PUT',
        body: { wrapped: wrapped() },
      });
      expect(res.status).toBe(403);
      expect((await call('/me', { token: sam.token })).json.passkey_unlock).toBe(false);
    } finally {
      if (before === undefined) delete e.PASSKEY_UNLOCK;
      else e.PASSKEY_UNLOCK = before;
    }
    expect((await call('/me', { token: sam.token })).json.passkey_unlock).toBe(true);
  });
});
