// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, couple, randomB64, signIn, uniqueEmail } from './helpers';

const wrapped = () => ({ nonce: randomB64(24), ciphertext: randomB64(120) });

describe('spaces', () => {
  it('creates a space with the creator as member a, up to the quota', async () => {
    const s = await signIn(uniqueEmail());
    const ids: number[] = [];
    for (let i = 0; i < 4; i++)
      ids.push((await call('/spaces', { token: s.token, body: {} })).status);
    expect(ids).toEqual([201, 201, 201, 409]);
    const me = await call('/me', { token: s.token });
    expect(me.json.spaces[0].role).toBe('a');
  });
});

describe('partner invites', () => {
  it('pairs two people, then cannot be reused', async () => {
    const { sam, alex, spaceId } = await couple();
    const me = await call('/me', { token: alex.token });
    expect(
      me.json.spaces.map((s: { space_id: string; role: string }) => [s.space_id, s.role]),
    ).toEqual([[spaceId, 'b']]);
    expect(me.json.spaces[0].members).toHaveLength(2);
    void sam;
  });

  it('is claimed by the first account that fetches it; others get 404', async () => {
    const sam = await signIn(uniqueEmail());
    const alex = await signIn(uniqueEmail());
    const eve = await signIn(uniqueEmail());
    const space = (await call('/spaces', { token: sam.token, body: {} })).json.id;
    const inv = (
      await call('/invites', {
        token: sam.token,
        body: { kind: 'partner', space_id: space, wrapped: wrapped() },
      })
    ).json.id;
    expect((await call(`/invites/${inv}`, { token: alex.token })).status).toBe(200);
    expect((await call(`/invites/${inv}`, { token: alex.token })).status).toBe(200); // same claimer may retry
    expect((await call(`/invites/${inv}`, { token: eve.token })).status).toBe(404);
    expect((await call(`/invites/${inv}/accept`, { token: eve.token, body: {} })).status).toBe(404);
    // The creator can't fetch their own partner invite.
    expect((await call(`/invites/${inv}`, { token: sam.token })).status).toBe(404);
  });

  it('is single use and erases the wrapped keys on accept', async () => {
    const sam = await signIn(uniqueEmail());
    const alex = await signIn(uniqueEmail());
    const space = (await call('/spaces', { token: sam.token, body: {} })).json.id;
    const inv = (
      await call('/invites', {
        token: sam.token,
        body: { kind: 'partner', space_id: space, wrapped: wrapped() },
      })
    ).json.id;
    await call(`/invites/${inv}`, { token: alex.token });
    expect((await call(`/invites/${inv}/accept`, { token: alex.token, body: {} })).json.role).toBe(
      'b',
    );
    expect((await call(`/invites/${inv}/accept`, { token: alex.token, body: {} })).status).toBe(
      404,
    );
    expect((await call(`/invites/${inv}`, { token: alex.token })).status).toBe(404);
    const row = await env.DB.prepare(
      'SELECT length(wrapped) AS n, id FROM invites WHERE space_id = ?',
    )
      .bind(space)
      .first<{ n: number; id: string }>();
    expect(row?.n).toBe(0);
    expect(row?.id).not.toBe(inv); // stored hashed
  });

  it('expires', async () => {
    const sam = await signIn(uniqueEmail());
    const alex = await signIn(uniqueEmail());
    const space = (await call('/spaces', { token: sam.token, body: {} })).json.id;
    const inv = (
      await call('/invites', {
        token: sam.token,
        body: { kind: 'partner', space_id: space, wrapped: wrapped() },
      })
    ).json.id;
    await env.DB.prepare('UPDATE invites SET expires_at = 1 WHERE space_id = ?').bind(space).run();
    expect((await call(`/invites/${inv}`, { token: alex.token })).status).toBe(404);
  });

  it('refuses a third member and non-members', async () => {
    const { sam, spaceId } = await couple();
    expect(
      (
        await call('/invites', {
          token: sam.token,
          body: { kind: 'partner', space_id: spaceId, wrapped: wrapped() },
        })
      ).json.error,
    ).toBe('space_full');
    const eve = await signIn(uniqueEmail());
    expect(
      (
        await call('/invites', {
          token: eve.token,
          body: { kind: 'partner', space_id: spaceId, wrapped: wrapped() },
        })
      ).status,
    ).toBe(404);
  });

  it('a new invite replaces the previous unused one', async () => {
    const sam = await signIn(uniqueEmail());
    const alex = await signIn(uniqueEmail());
    const space = (await call('/spaces', { token: sam.token, body: {} })).json.id;
    const first = (
      await call('/invites', {
        token: sam.token,
        body: { kind: 'partner', space_id: space, wrapped: wrapped() },
      })
    ).json.id;
    await call('/invites', {
      token: sam.token,
      body: { kind: 'partner', space_id: space, wrapped: wrapped() },
    });
    expect((await call(`/invites/${first}`, { token: alex.token })).status).toBe(404);
  });
});

describe('device invites', () => {
  it('can only be opened by the same account', async () => {
    const email = uniqueEmail();
    const phone = await signIn(email);
    const laptop = await signIn(email);
    const other = await signIn(uniqueEmail());
    const inv = (
      await call('/invites', { token: phone.token, body: { kind: 'device', wrapped: wrapped() } })
    ).json.id;
    expect((await call(`/invites/${inv}`, { token: other.token })).status).toBe(404);
    const got = await call(`/invites/${inv}`, { token: laptop.token });
    expect(got.status).toBe(200);
    expect(got.json.kind).toBe('device');
    expect(got.json.wrapped.nonce).toHaveLength(32);
    expect((await call(`/invites/${inv}/accept`, { token: laptop.token, body: {} })).status).toBe(
      200,
    );
  });
});

describe('sign-up policy', () => {
  it('invite-only and closed modes still let an invited partner join', async () => {
    const sam = await signIn(uniqueEmail());
    const space = (await call('/spaces', { token: sam.token, body: {} })).json.id;
    const inv = (
      await call('/invites', {
        token: sam.token,
        body: { kind: 'partner', space_id: space, wrapped: wrapped() },
      })
    ).json.id;
    const original = env.ALLOW_SIGNUPS;
    (env as { ALLOW_SIGNUPS: string }).ALLOW_SIGNUPS = 'closed';
    try {
      await expect(signIn(uniqueEmail())).rejects.toThrow('no email sent');
      // The invite given when asking for the link is the one used: the
      // device needn't send it again when opening the link (review 0007, I11).
      const alex = await signIn(uniqueEmail(), { invite: inv, inviteAtVerify: false });
      expect(alex.token).toHaveLength(43);
      // Existing accounts can still sign in.
      expect((await call('/me', { token: sam.token })).status).toBe(200);
    } finally {
      (env as { ALLOW_SIGNUPS: string }).ALLOW_SIGNUPS = original;
    }
  });
});

describe('key backups', () => {
  const backup = (version: number) => ({
    version,
    wrapped: { nonce: randomB64(24), ciphertext: randomB64(200) },
  });

  it('stores versions in order and refuses rollbacks', async () => {
    const s = await signIn(uniqueEmail());
    expect((await call('/keys/backup', { token: s.token })).status).toBe(404);
    expect(
      (await call('/keys/backup', { method: 'PUT', token: s.token, body: backup(2) })).status,
    ).toBe(409);
    expect(
      (await call('/keys/backup', { method: 'PUT', token: s.token, body: backup(1) })).status,
    ).toBe(200);
    expect(
      (await call('/keys/backup', { method: 'PUT', token: s.token, body: backup(2) })).status,
    ).toBe(200);
    const stale = await call('/keys/backup', { method: 'PUT', token: s.token, body: backup(2) });
    expect(stale.status).toBe(409);
    expect(stale.json.current_version).toBe(2);
    expect((await call('/keys/backup', { token: s.token })).json.version).toBe(2);
  });

  it('is private to its owner', async () => {
    const a = await signIn(uniqueEmail());
    const b = await signIn(uniqueEmail());
    await call('/keys/backup', { method: 'PUT', token: a.token, body: backup(1) });
    expect((await call('/keys/backup', { token: b.token })).status).toBe(404);
  });
});
