// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Joining a partner with an existing account (ADR 0016, review 0007): the
 * join and leaving the old space happen in one step, or not at all.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, envelope, randomB64, signIn, uniqueEmail } from './helpers';

const push = (token: string, spaceId: string, n: number) =>
  call('/sync/push', {
    token,
    body: {
      space_id: spaceId,
      items: Array.from({ length: n }, () => ({ envelope: envelope(spaceId), base_rev: 0 })),
    },
  });

/** Kim alone in a space of their own with `records` records; Jo inviting Kim. */
async function setUp(records: number) {
  const kim = await signIn(uniqueEmail('kim'));
  const own = (await call('/spaces', { token: kim.token, body: {} })).json.id as string;
  if (records) expect((await push(kim.token, own, records)).status).toBe(200);
  const jo = await signIn(uniqueEmail('jo'));
  const theirs = (await call('/spaces', { token: jo.token, body: {} })).json.id as string;
  const inv = await call('/invites', {
    token: jo.token,
    body: {
      kind: 'partner',
      space_id: theirs,
      wrapped: { nonce: randomB64(24), ciphertext: randomB64(120) },
    },
  });
  const id = inv.json.id as string;
  expect((await call(`/invites/${id}`, { token: kim.token })).status).toBe(200);
  const accept = (leave: { space_id: string; records: number; ids?: string[] }) =>
    call(`/invites/${id}/accept`, { token: kim.token, body: { leave } });
  const spacesOf = async () =>
    (await call('/me', { token: kim.token })).json.spaces.map(
      (x: { space_id: string }) => x.space_id,
    );
  return { kim, jo, own, theirs, id, accept, spacesOf };
}

describe('joining with an existing account', () => {
  it('joins and leaves the old space in one step', async () => {
    const t = await setUp(2);
    expect((await t.accept({ space_id: t.own, records: 2 })).status).toBe(200);
    expect(await t.spacesOf()).toEqual([t.theirs]);
    // The old space and everything in it are gone.
    const left = await env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM spaces WHERE id = ?1) AS spaces, (SELECT COUNT(*) FROM records WHERE space_id = ?1) AS records',
    )
      .bind(t.own)
      .first<{ spaces: number; records: number }>();
    expect(left).toEqual({ spaces: 0, records: 0 });
  });

  it('changes nothing if the old space holds more than agreed (M2)', async () => {
    const t = await setUp(3);
    const res = await t.accept({ space_id: t.own, records: 2 });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('space_changed');
    expect(await t.spacesOf()).toEqual([t.own]);
    // The invite is still good once the person has seen everything.
    expect((await t.accept({ space_id: t.own, records: 3 })).status).toBe(200);
    expect(await t.spacesOf()).toEqual([t.theirs]);
  });

  it('changes nothing if someone else is in the old space', async () => {
    const t = await setUp(0);
    await env.DB.prepare(
      "INSERT INTO memberships (space_id, user_id, role, joined_at) VALUES (?, ?, 'b', ?)",
    )
      .bind(t.own, t.jo.userId, Date.now())
      .run();
    const res = await t.accept({ space_id: t.own, records: 5 });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('not_alone');
    expect(await t.spacesOf()).toEqual([t.own]);
  });

  it('changes nothing if the partner’s space is full', async () => {
    const t = await setUp(0);
    const other = await signIn(uniqueEmail('other'));
    await env.DB.prepare(
      "INSERT INTO memberships (space_id, user_id, role, joined_at) VALUES (?, ?, 'b', ?)",
    )
      .bind(t.theirs, other.userId, Date.now())
      .run();
    const res = await t.accept({ space_id: t.own, records: 0 });
    expect(res.status).toBe(409);
    expect(await t.spacesOf()).toEqual([t.own]);
    const space = await env.DB.prepare('SELECT 1 AS x FROM spaces WHERE id = ?')
      .bind(t.own)
      .first();
    expect(space).toEqual({ x: 1 });
  });

  it('changes nothing if a record outside those shown is live, whatever the count (I9)', async () => {
    const t = await setUp(2);
    const shown = (
      await call(`/sync/pull?space_id=${t.own}&since=0`, { token: t.kim.token })
    ).json.envelopes.map((e: { id: string }) => e.id) as string[];
    expect(shown).toHaveLength(2);
    // The right number, but one of them isn't what was shown.
    const res = await t.accept({ space_id: t.own, records: 2, ids: [shown[0] ?? '', 'other'] });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('space_changed');
    expect(await t.spacesOf()).toEqual([t.own]);
    expect((await t.accept({ space_id: t.own, records: 2, ids: shown })).status).toBe(200);
    expect(await t.spacesOf()).toEqual([t.theirs]);
  });

  it('an opened invite can be let go of, for the right person to use (I8)', async () => {
    const t = await setUp(0);
    const other = await signIn(uniqueEmail('lee'));
    expect((await call(`/invites/${t.id}`, { token: other.token })).status).toBe(404);
    // Only the account that opened it can let it go.
    await call(`/invites/${t.id}/release`, { token: other.token, body: {} });
    expect((await call(`/invites/${t.id}`, { token: other.token })).status).toBe(404);
    await call(`/invites/${t.id}/release`, { token: t.kim.token, body: {} });
    expect((await call(`/invites/${t.id}`, { token: other.token })).status).toBe(200);
  });

  it('can’t be used to leave someone else’s space', async () => {
    const t = await setUp(0);
    const res = await t.accept({ space_id: t.theirs, records: 0 });
    expect(res.status).toBe(409);
    expect(await t.spacesOf()).toEqual([t.own]);
  });
});
