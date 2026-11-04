// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, couple, outbox, randomB64 } from './helpers';

const wrapped = () => ({ nonce: randomB64(24), ciphertext: randomB64(200) });
const copy = (space = 1, personal = 1) => ({
  space_version: space,
  personal_version: personal,
  wrapped: wrapped(),
});
const addPasskey = (userId: string, id: string) =>
  env.DB.prepare(
    'INSERT INTO passkeys (id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, 0, ?)',
  )
    .bind(id, userId, new Uint8Array(8), Date.now())
    .run();
/** As if this session had just confirmed with that passkey (POST /auth/passkey/reauth). */
const confirmWith = (userId: string, passkey: string) =>
  env.DB.prepare('UPDATE sessions SET passkey_id = ?, reauth_at = ? WHERE user_id = ?')
    .bind(passkey, Date.now(), userId)
    .run();
const waitForMail = async (n: number) => {
  for (let i = 0; i < 100 && outbox.length < n; i++) await new Promise((r) => setTimeout(r, 5));
};
const put = (token: string, id: string, body: unknown) =>
  call(`/keys/unlock/${id}`, { token, method: 'PUT', body });

describe('passkey unlock (ADR 0015)', () => {
  it('keeps one sealed copy per passkey, only for its owner', async () => {
    const { sam, alex } = await couple();
    const pk = `pk-sam-${Date.now()}-aaaaaaaaaa`;
    await addPasskey(sam.userId, pk);
    const body = copy();
    // Only from a session that just confirmed with that passkey (review 0006, L2).
    expect((await put(sam.token, pk, body)).status).toBe(403);
    await confirmWith(sam.userId, pk);
    const before = outbox.length;
    expect((await put(sam.token, pk, body)).status).toBe(200);
    await waitForMail(before + 1);
    expect(outbox.slice(before).some((m) => /Passkey unlock is on/.test(m.subject))).toBe(true);
    // Someone else's passkey: refused, and never shown.
    expect((await put(alex.token, pk, copy())).status).toBe(403);
    expect((await call(`/keys/unlock/${pk}`, { token: alex.token })).status).toBe(404);
    const list = await call('/keys/unlocks', { token: sam.token });
    expect(list.json.unlocks.map((u: { passkey_id: string }) => u.passkey_id)).toEqual([pk]);
    // The key versions it holds are listed, so any device can tell it's behind (L4).
    expect(list.json.unlocks[0]).toMatchObject({ space_version: 1, personal_version: 1 });
    // Fetching it (to unlock a new device) tells the owner what the server knows (L3).
    const n = outbox.length;
    const got = await call(`/keys/unlock/${pk}`, { token: sam.token });
    expect(got.json.wrapped).toEqual(body.wrapped);
    await waitForMail(n + 1);
    expect(outbox.slice(n).some((m) => /asked to unlock your Ours keys/.test(m.subject))).toBe(
      true,
    );
    // Turning it off is told too (L2).
    const m = outbox.length;
    await call(`/keys/unlock/${pk}`, { token: sam.token, method: 'DELETE' });
    await waitForMail(m + 1);
    expect(outbox.slice(m).some((x) => /no longer unlocks/.test(x.subject))).toBe(true);
  });

  it('goes with the passkey and a change of keys, and old passkeys stay out (M1)', async () => {
    const { sam, spaceId } = await couple();
    const a = `pk-a-${Date.now()}-aaaaaaaaaa`;
    const b = `pk-b-${Date.now()}-bbbbbbbbbb`;
    await addPasskey(sam.userId, a);
    await addPasskey(sam.userId, b);
    for (const id of [a, b]) {
      await confirmWith(sam.userId, id);
      expect((await put(sam.token, id, copy())).status).toBe(200);
    }
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
    // A passkey added before the change can't unlock again: the lost phone may hold it.
    await confirmWith(sam.userId, b);
    const old = await put(sam.token, b, copy(2, 2));
    expect(old.status).toBe(409);
    expect(old.json.error).toBe('passkey_too_old');
    const listed = await call('/auth/passkeys', { token: sam.token });
    expect(listed.json.passkeys).toMatchObject([{ id: b, can_unlock: false }]);
    // A passkey added since can.
    await new Promise((r) => setTimeout(r, 5));
    const c = `pk-c-${Date.now()}-cccccccccc`;
    await addPasskey(sam.userId, c);
    await confirmWith(sam.userId, c);
    expect((await put(sam.token, c, copy(2, 2))).status).toBe(200);
  });

  it('tells every fetch, and never lets older keys replace newer ones (N4, I8)', async () => {
    const { sam } = await couple();
    const pk = `pk-n4-${Date.now()}-aaaaaaaaaa`;
    await addPasskey(sam.userId, pk);
    await confirmWith(sam.userId, pk);
    expect((await put(sam.token, pk, copy(2, 2))).status).toBe(200);
    const n = outbox.length;
    await call(`/keys/unlock/${pk}`, { token: sam.token });
    await call(`/keys/unlock/${pk}`, { token: sam.token });
    await waitForMail(n + 2);
    expect(outbox.slice(n).filter((m) => /asked to unlock/.test(m.subject))).toHaveLength(2);
    const older = await put(sam.token, pk, copy(2, 1));
    expect(older.status).toBe(409);
    expect(older.json.error).toBe('newer_copy');
    // A lower space version alone is fine: a new space starts again at 1 (F2).
    expect((await put(sam.token, pk, copy(1, 2))).status).toBe(200);
  });

  it('needs a confirmation from the last ten minutes (L2)', async () => {
    const { sam } = await couple();
    const pk = `pk-late-${Date.now()}-aaaaaaaaaa`;
    await addPasskey(sam.userId, pk);
    const old = Date.now() - 11 * 60_000;
    await env.DB.prepare(
      'UPDATE sessions SET passkey_id = ?, reauth_at = ?, created_at = ? WHERE user_id = ?',
    )
      .bind(pk, old, old, sam.userId)
      .run();
    expect((await put(sam.token, pk, copy())).status).toBe(403);
  });
});

describe('passkey unlock switch', () => {
  it('when off, nothing can be set up, listed or fetched (L1), and /me says so', async () => {
    const { sam } = await couple();
    const pk = `pk-off-${Date.now()}-aaaaaaaaaa`;
    await addPasskey(sam.userId, pk);
    await confirmWith(sam.userId, pk);
    expect((await put(sam.token, pk, copy())).status).toBe(200);
    const e = env as unknown as { PASSKEY_UNLOCK?: string };
    const before = e.PASSKEY_UNLOCK;
    e.PASSKEY_UNLOCK = 'off';
    try {
      expect((await put(sam.token, pk, copy())).status).toBe(403);
      expect((await call(`/keys/unlock/${pk}`, { token: sam.token })).status).toBe(403);
      expect((await call('/keys/unlocks', { token: sam.token })).status).toBe(403);
      expect((await call('/me', { token: sam.token })).json.passkey_unlock).toBe(false);
      // Turning it off still works.
      expect(
        (await call(`/keys/unlock/${pk}`, { token: sam.token, method: 'DELETE' })).status,
      ).toBe(200);
    } finally {
      if (before === undefined) delete e.PASSKEY_UNLOCK;
      else e.PASSKEY_UNLOCK = before;
    }
    expect((await call('/me', { token: sam.token })).json.passkey_unlock).toBe(true);
  });
});
