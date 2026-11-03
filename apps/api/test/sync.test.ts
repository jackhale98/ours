// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, couple, envelope, signIn, uniqueEmail } from './helpers';

const push = (token: string, spaceId: string, items: { envelope: unknown; base_rev: number }[]) =>
  call('/sync/push', { token, body: { space_id: spaceId, items } });
const pull = (token: string, spaceId: string, since = 0, limit?: number) =>
  call(`/sync/pull?space_id=${spaceId}&since=${since}${limit ? `&limit=${limit}` : ''}`, { token });

describe('push and pull', () => {
  it('assigns increasing revs and pulls them in order with a cursor', async () => {
    const { sam, alex, spaceId } = await couple();
    const a = envelope(spaceId);
    const b = envelope(spaceId);
    const res = await push(sam.token, spaceId, [
      { envelope: a, base_rev: 0 },
      { envelope: b, base_rev: 0 },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.results.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok']);
    const [r1, r2] = res.json.results.map((r: { rev: number }) => r.rev);
    expect(r2).toBe(r1 + 1);
    expect(res.json.seq).toBe(r2);

    const page = await pull(alex.token, spaceId, 0, 1);
    expect(page.json.envelopes.map((e: { id: string }) => e.id)).toEqual([a.id]);
    expect(page.json.more).toBe(true);
    const next = await pull(alex.token, spaceId, page.json.cursor);
    expect(next.json.envelopes.map((e: { id: string }) => e.id)).toEqual([b.id]);
    expect(next.json.more).toBe(false);
    expect(next.json.envelopes[0]).toMatchObject({
      ciphertext: b.ciphertext,
      nonce: b.nonce,
      updated_by: sam.userId,
      deleted: false,
    });
  });

  it('is idempotent: retrying the same write returns the same rev', async () => {
    const { sam, spaceId } = await couple();
    const e = envelope(spaceId);
    const first = await push(sam.token, spaceId, [{ envelope: e, base_rev: 0 }]);
    const again = await push(sam.token, spaceId, [{ envelope: e, base_rev: 0 }]);
    expect(again.json.results[0]).toEqual(first.json.results[0]);
  });

  it('returns a conflict with the current envelope when the base is stale', async () => {
    const { sam, alex, spaceId } = await couple();
    const e = envelope(spaceId);
    const v1 = (await push(sam.token, spaceId, [{ envelope: e, base_rev: 0 }])).json.results[0].rev;
    const fromAlex = { ...envelope(spaceId, { id: e.id }) };
    const ok = await push(alex.token, spaceId, [{ envelope: fromAlex, base_rev: v1 }]);
    expect(ok.json.results[0].status).toBe('ok');
    const fromSam = { ...envelope(spaceId, { id: e.id }) };
    const conflict = await push(sam.token, spaceId, [{ envelope: fromSam, base_rev: v1 }]);
    expect(conflict.json.results[0].status).toBe('conflict');
    expect(conflict.json.results[0].current.ciphertext).toBe(fromAlex.ciphertext);
    expect(conflict.json.results[0].current.updated_by).toBe(alex.userId);
  });

  it('tombstones sync like any write', async () => {
    const { sam, alex, spaceId } = await couple();
    const e = envelope(spaceId);
    const rev = (await push(sam.token, spaceId, [{ envelope: e, base_rev: 0 }])).json.results[0]
      .rev;
    await push(sam.token, spaceId, [
      { envelope: { ...envelope(spaceId, { id: e.id }), deleted: true }, base_rev: rev },
    ]);
    const all = await pull(alex.token, spaceId);
    expect(all.json.envelopes.find((x: { id: string }) => x.id === e.id).deleted).toBe(true);
  });
});

describe('access control (enforced in SQL)', () => {
  it('non-members cannot push or pull', async () => {
    const { sam, spaceId } = await couple();
    const eve = await signIn(uniqueEmail());
    await push(sam.token, spaceId, [{ envelope: envelope(spaceId), base_rev: 0 }]);
    expect((await pull(eve.token, spaceId)).status).toBe(404);
    expect(
      (await push(eve.token, spaceId, [{ envelope: envelope(spaceId), base_rev: 0 }])).status,
    ).toBe(404);
  });

  it('a record id from another space cannot be read or overwritten', async () => {
    const one = await couple();
    const two = await couple();
    const e = envelope(one.spaceId);
    await push(one.sam.token, one.spaceId, [{ envelope: e, base_rev: 0 }]);
    const hijack = await push(two.sam.token, two.spaceId, [
      { envelope: envelope(two.spaceId, { id: e.id }), base_rev: 0 },
    ]);
    expect(hijack.json.results[0]).toEqual({ status: 'rejected', id: e.id, reason: 'not_allowed' });
    expect(JSON.stringify(hijack.json)).not.toContain(e.ciphertext);
    const still = await pull(one.alex.token, one.spaceId);
    expect(still.json.envelopes[0].ciphertext).toBe(e.ciphertext);
  });

  it('envelopes must belong to the request space', async () => {
    const { sam, spaceId } = await couple();
    const other = await couple();
    const res = await push(sam.token, spaceId, [
      { envelope: envelope(other.spaceId), base_rev: 0 },
    ]);
    expect(res.status).toBe(422);
  });

  it('private records are written only as yourself and returned only to you', async () => {
    const { sam, alex, spaceId } = await couple();
    const mine = envelope(spaceId, { scope: 'user', owner: sam.userId });
    expect(
      (await push(sam.token, spaceId, [{ envelope: mine, base_rev: 0 }])).json.results[0].status,
    ).toBe('ok');
    // Alex can't write a record claiming to be Sam's.
    const forged = envelope(spaceId, { scope: 'user', owner: sam.userId });
    expect(
      (await push(alex.token, spaceId, [{ envelope: forged, base_rev: 0 }])).json.results[0].reason,
    ).toBe('not_owner');
    // Alex never receives Sam's private record.
    expect(
      (await pull(alex.token, spaceId)).json.envelopes.map((e: { id: string }) => e.id),
    ).not.toContain(mine.id);
    expect(
      (await pull(sam.token, spaceId)).json.envelopes.map((e: { id: string }) => e.id),
    ).toContain(mine.id);
    // Alex can't overwrite it as a shared record, or as Alex's own.
    const asShared = envelope(spaceId, { id: mine.id });
    expect(
      (await push(alex.token, spaceId, [{ envelope: asShared, base_rev: 1 }])).json.results[0]
        .reason,
    ).toBe('not_allowed');
    const asAlex = envelope(spaceId, { id: mine.id, scope: 'user', owner: alex.userId });
    expect(
      (await push(alex.token, spaceId, [{ envelope: asAlex, base_rev: 1 }])).json.results[0].reason,
    ).toBe('not_allowed');
  });
});

describe('quotas', () => {
  it('refuses writes over the per-space storage quota', async () => {
    const { sam, spaceId } = await couple();
    // Test config sets MAX_SPACE_BYTES to 200 000.
    const big = () => ({ envelope: envelope(spaceId, { size: 60_000 }), base_rev: 0 });
    const ok = await push(sam.token, spaceId, [big(), big(), big()]);
    expect(ok.json.results.every((r: { status: string }) => r.status === 'ok')).toBe(true);
    const over = await push(sam.token, spaceId, [big()]);
    expect(over.json.results[0].reason).toBe('quota');
    const space = await env.DB.prepare('SELECT bytes FROM spaces WHERE id = ?')
      .bind(spaceId)
      .first<{ bytes: number }>();
    expect(space?.bytes).toBe(3 * (60_000 + 24 + 256));
  });

  it('refuses oversized records', async () => {
    const { sam, spaceId } = await couple();
    const res = await push(sam.token, spaceId, [
      { envelope: envelope(spaceId, { size: 70_000 }), base_rev: 0 },
    ]);
    expect(res.status).toBe(422); // rejected by the shared envelope schema
  });
});

describe('account deletion', () => {
  it('purges private data, keeps shared records for the partner, and drops empty spaces', async () => {
    const { sam, alex, spaceId } = await couple();
    const shared = envelope(spaceId);
    const privateRec = envelope(spaceId, { scope: 'user', owner: alex.userId });
    await push(sam.token, spaceId, [{ envelope: shared, base_rev: 0 }]);
    await push(alex.token, spaceId, [{ envelope: privateRec, base_rev: 0 }]);
    expect((await call('/me', { method: 'DELETE', token: alex.token })).status).toBe(200);
    expect((await call('/me', { token: alex.token })).status).toBe(401);
    for (const table of ['sessions', 'devices', 'memberships', 'passkeys', 'key_backups']) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
        .bind(alex.userId)
        .first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
    expect(
      await env.DB.prepare('SELECT 1 FROM records WHERE id = ?').bind(privateRec.id).first(),
    ).toBeNull();
    expect(
      (await pull(sam.token, spaceId)).json.envelopes.map((e: { id: string }) => e.id),
    ).toEqual([shared.id]);

    expect((await call('/me', { method: 'DELETE', token: sam.token })).status).toBe(200);
    expect(
      await env.DB.prepare('SELECT 1 FROM spaces WHERE id = ?').bind(spaceId).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT 1 FROM records WHERE id = ?').bind(shared.id).first(),
    ).toBeNull();
  });
});
