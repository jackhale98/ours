// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { rotateStatements } from '../src/routes/spaces';
import { call, couple, envelope, outbox, randomB64, signIn, uniqueEmail } from './helpers';

const kid = () => randomB64(16);
const rot = (space_from: number, personal_from: number) => ({
  space_from,
  personal_from,
  space_kid: kid(),
  personal_kid: kid(),
});
const sealedPayload = () => ({ nonce: randomB64(24), ciphertext: randomB64(64) });

const push = (token: string, spaceId: string, items: unknown[]) =>
  call('/sync/push', { token, body: { space_id: spaceId, items } });

describe('key rotation (ADR 0013)', () => {
  it('raises the minimum key versions by one and refuses old-key writes', async () => {
    const { sam, alex, spaceId } = await couple();
    const before = await push(sam.token, spaceId, [{ envelope: envelope(spaceId), base_rev: 0 }]);
    expect(before.json.results[0].status).toBe('ok');

    const rotated = await call(`/spaces/${spaceId}/rotate`, {
      token: sam.token,
      body: rot(1, 1),
    });
    expect(rotated.status).toBe(200);
    expect(rotated.json).toMatchObject({ key_version: 2, personal_key_version: 2 });
    expect(rotated.json.rotated_rev).toBeGreaterThan(0);

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
      body: rot(2, 1),
    });
    expect(skip.status).toBe(409);
    await call(`/spaces/${spaceId}/rotate`, {
      token: sam.token,
      body: rot(1, 1),
    });
    // Alex rotating from the same starting point loses the race.
    const late = await call(`/spaces/${spaceId}/rotate`, {
      token: alex.token,
      body: rot(1, 1),
    });
    expect(late.status).toBe(409);
  });

  it('a key update link can only be claimed by the partner, and nobody joins', async () => {
    const { sam, alex, spaceId } = await couple();
    await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
    const wrapped = { nonce: randomB64(24), ciphertext: randomB64(120) };
    const inv = await call('/invites', {
      token: sam.token,
      body: { kind: 'rekey', space_id: spaceId, key_version: 2, wrapped },
    });
    expect(inv.status).toBe(201);
    // Sam can't claim his own; an outsider can't either.
    expect((await call(`/invites/${inv.json.id}`, { token: sam.token })).status).toBe(404);
    const outsider = await couple();
    expect((await call(`/invites/${inv.json.id}`, { token: outsider.sam.token })).status).toBe(404);
    // Looking at its kind doesn't use it up (I1).
    const kind = await call(`/invites/${inv.json.id}/kind`, { token: alex.token });
    expect(kind.json).toMatchObject({ kind: 'rekey', space_id: spaceId, key_version: 2 });
    const got = await call(`/invites/${inv.json.id}`, { token: alex.token });
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ kind: 'rekey', space_id: spaceId, wrapped, key_version: 2 });
    const acc = await call(`/invites/${inv.json.id}/accept`, { token: alex.token, body: {} });
    expect(acc.status).toBe(200);
    // Used once: gone.
    expect((await call(`/invites/${inv.json.id}`, { token: alex.token })).status).toBe(404);
    const me = await call('/me', { token: alex.token });
    expect(me.json.spaces[0].members).toHaveLength(2);
  });
});

describe('key rotation review 0005', () => {
  it('refuses writes under a version newer than the current one (H1)', async () => {
    const { sam, spaceId } = await couple();
    const ahead = await push(sam.token, spaceId, [
      { envelope: { ...envelope(spaceId), key_version: 2 }, base_rev: 0 },
    ]);
    expect(ahead.json.results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_key' });
    const mine = await push(sam.token, spaceId, [
      {
        envelope: { ...envelope(spaceId, { scope: 'user', owner: sam.userId }), key_version: 2 },
        base_rev: 0,
      },
    ]);
    expect(mine.json.results[0].reason).toBe('unknown_key');
    const note = await call('/push/notify', {
      token: sam.token,
      body: { space_id: spaceId, key_version: 2, to: 'partner', payload: sealedPayload() },
    });
    expect(note.status).toBe(409);
    const reminder = await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: {
        space_id: spaceId,
        items: [{ fire_at: Date.now() + 60_000, key_version: 2, payload: sealedPayload() }],
      },
    });
    expect(reminder.status).toBe(409);
  });

  it('records key fingerprints and returns them from /me (H1)', async () => {
    const { sam, alex, spaceId } = await couple();
    const body = rot(1, 1);
    expect((await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body })).status).toBe(200);
    const me = await call('/me', { token: sam.token });
    expect(me.json.spaces[0].kids).toEqual([{ version: 2, kid: body.space_kid }]);
    expect(me.json.user.personal_kids).toEqual([{ version: 2, kid: body.personal_kid }]);
    expect(me.json.spaces[0]).toMatchObject({ rotated_by: sam.userId });
    // The partner sees the space fingerprint, never Sam's personal one.
    const theirs = await call('/me', { token: alex.token });
    expect(theirs.json.spaces[0].kids).toEqual([{ version: 2, kid: body.space_kid }]);
    expect(theirs.json.user.personal_kids).toEqual([]);
    const bad = await call(`/spaces/${spaceId}/rotate`, {
      token: alex.token,
      body: { ...rot(2, 1), space_kid: 'short' },
    });
    expect(bad.status).toBe(422);
  });

  it('rolls the whole rotation back when the partner rotated in between (M1)', async () => {
    const { sam, alex, spaceId } = await couple();
    // Both read version 1; Sam's lands first. Alex's batch then runs as the
    // route would after its check passed.
    await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
    const late = rotateStatements(env.DB, {
      spaceId,
      userId: alex.userId,
      spaceFrom: 1,
      personalFrom: 1,
      spaceKid: kid(),
      personalKid: kid(),
      now: Date.now(),
    });
    await expect(env.DB.batch(late)).rejects.toThrow(/quota_guard/);
    const me = await call('/me', { token: alex.token });
    expect(me.json.user.personal_key_version).toBe(1);
    expect(me.json.user.personal_kids).toEqual([]);
    expect(me.json.spaces[0]).toMatchObject({ key_version: 2, rotated_by: sam.userId });
  });

  it('needs a recent passkey check when there is a passkey (M4)', async () => {
    const { sam, spaceId } = await couple();
    await env.DB.prepare(
      'INSERT INTO passkeys (id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, 0, ?)',
    )
      .bind(`pk-${spaceId}`, sam.userId, new Uint8Array(8), Date.now())
      .run();
    await env.DB.prepare('UPDATE sessions SET created_at = ? WHERE user_id = ?')
      .bind(Date.now() - 3_600_000, sam.userId)
      .run();
    const stale = await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
    expect(stale.status).toBe(403);
    expect(stale.json.error).toBe('reauth_required');
    await env.DB.prepare('UPDATE sessions SET reauth_at = ? WHERE user_id = ?')
      .bind(Date.now(), sam.userId)
      .run();
    const ok = await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
    expect(ok.status).toBe(200);
  });

  it('emails both members when keys change (M4)', async () => {
    const { sam, alex, spaceId } = await couple();
    const before = outbox.length;
    await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
    for (let i = 0; i < 100 && outbox.length < before + 2; i++)
      await new Promise((r) => setTimeout(r, 5));
    const sent = outbox.slice(before).filter((m) => /keys for your Ours space/.test(m.subject));
    expect(sent.map((m) => m.to).sort()).toEqual([sam.email, alex.email].sort());
  });

  it('only the rotator sends key update links, for the current version, for two weeks (M4)', async () => {
    const { sam, alex, spaceId } = await couple();
    const wrapped = { nonce: randomB64(24), ciphertext: randomB64(120) };
    const link = (token: string, key_version: number) =>
      call('/invites', { token, body: { kind: 'rekey', space_id: spaceId, key_version, wrapped } });
    // Nothing rotated yet: nobody can make one.
    expect((await link(sam.token, 2)).status).toBe(409);
    await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
    expect((await link(alex.token, 2)).status).toBe(409);
    expect((await link(sam.token, 3)).status).toBe(409);
    const first = await link(sam.token, 2);
    expect(first.status).toBe(201);
    // Too long after the rotation.
    await env.DB.prepare('UPDATE spaces SET rotated_at = ? WHERE id = ?')
      .bind(Date.now() - 15 * 86_400_000, spaceId)
      .run();
    expect((await link(sam.token, 2)).status).toBe(409);
    // A link for a version that's no longer current can't be claimed.
    await env.DB.prepare('UPDATE spaces SET rotated_at = ? WHERE id = ?')
      .bind(Date.now(), spaceId)
      .run();
    const fresh = await link(sam.token, 2);
    await call(`/spaces/${spaceId}/rotate`, { token: alex.token, body: rot(2, 1) });
    expect((await call(`/invites/${fresh.json.id}`, { token: alex.token })).status).toBe(404);
  });

  it('counts what is still under old keys, and takes acknowledgements (M2, M3)', async () => {
    const { sam, alex, spaceId } = await couple();
    const shared = envelope(spaceId);
    const mine = envelope(spaceId, { scope: 'user', owner: sam.userId });
    const theirs = envelope(spaceId, { scope: 'user', owner: alex.userId });
    const first = await push(sam.token, spaceId, [
      { envelope: shared, base_rev: 0 },
      { envelope: mine, base_rev: 0 },
    ]);
    await push(alex.token, spaceId, [{ envelope: theirs, base_rev: 0 }]);
    const body = rot(1, 1);
    await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body });
    const status = await call(`/spaces/${spaceId}/rotation`, { token: sam.token });
    // Alex's personal record is under Alex's key, which didn't change.
    expect(status.json).toMatchObject({ key_version: 2, space_below: 1, mine_below: 1 });
    const again = await push(sam.token, spaceId, [
      { envelope: { ...shared, key_version: 2 }, base_rev: first.json.results[0].rev },
      { envelope: { ...mine, key_version: 2 }, base_rev: first.json.results[1].rev },
    ]);
    expect(again.json.results.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok']);
    const done = await call(`/spaces/${spaceId}/rotation`, { token: sam.token });
    expect(done.json).toMatchObject({ space_below: 0, mine_below: 0 });

    // Alex confirms holding v2: only with its real fingerprint.
    const wrong = await call(`/spaces/${spaceId}/keys-ack`, {
      token: alex.token,
      body: { key_version: 2, kid: kid() },
    });
    expect(wrong.status).toBe(409);
    const right = await call(`/spaces/${spaceId}/keys-ack`, {
      token: alex.token,
      body: { key_version: 2, kid: body.space_kid },
    });
    expect(right.status).toBe(200);
    const me = await call('/me', { token: sam.token });
    const alexRow = me.json.spaces[0].members.find(
      (m: { user_id: string }) => m.user_id === alex.userId,
    );
    expect(alexRow.key_version).toBe(2);
  });

  it('drops reminders and held notifications under the old keys (L2)', async () => {
    const { sam, alex, spaceId } = await couple();
    await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: {
        space_id: spaceId,
        items: [{ fire_at: Date.now() + 3_600_000, key_version: 1, payload: sealedPayload() }],
      },
    });
    await call('/push/reminders', {
      token: alex.token,
      method: 'PUT',
      body: {
        space_id: spaceId,
        items: [{ fire_at: Date.now() + 3_600_000, key_version: 1, payload: sealedPayload() }],
      },
    });
    const count = async (who: string) =>
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM reminders WHERE target_user_id = ?')
          .bind(who)
          .first<{ n: number }>()
      )?.n;
    expect(await count(sam.userId)).toBe(1);
    await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
    expect(await count(sam.userId)).toBe(0);
    // Alex's own reminders are under Alex's personal key, which didn't change.
    expect(await count(alex.userId)).toBe(1);
  });

  it('refuses rotation for an account in more than one space (L4)', async () => {
    const { sam, spaceId } = await couple();
    await call('/spaces', { token: sam.token, body: {} });
    const res = await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('multi_space');
  });

  it('doesn’t count refused attempts against the daily limit (I5)', async () => {
    const { sam, spaceId } = await couple();
    for (let i = 0; i < 12; i++) {
      const stale = await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(5, 1) });
      expect(stale.status).toBe(409);
    }
    const ok = await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
    expect(ok.status).toBe(200);
  });

  it('forgets fingerprints when the space and account go (cleanup)', async () => {
    const solo = await signIn(uniqueEmail('solo'));
    const space = await call('/spaces', { token: solo.token, body: {} });
    await call(`/spaces/${space.json.id}/rotate`, { token: solo.token, body: rot(1, 1) });
    await call('/me', { token: solo.token, method: 'DELETE' });
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM key_ids WHERE owner IN (?, ?)')
      .bind(space.json.id, solo.userId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe('rotation switch', () => {
  it('refuses rotating and key update links when switched off', async () => {
    const { sam, spaceId } = await couple();
    const e = env as unknown as { ROTATION?: string };
    const before = e.ROTATION;
    e.ROTATION = 'off';
    try {
      const res = await call(`/spaces/${spaceId}/rotate`, { token: sam.token, body: rot(1, 1) });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('rotation_off');
      const link = await call('/invites', {
        token: sam.token,
        body: {
          kind: 'rekey',
          space_id: spaceId,
          key_version: 2,
          wrapped: { nonce: randomB64(24), ciphertext: randomB64(120) },
        },
      });
      expect(link.status).toBe(403);
    } finally {
      e.ROTATION = before;
    }
  });
});
