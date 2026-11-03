// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Invites carry key material wrapped with a secret that only exists in the
 * invite link's fragment; the server stores ciphertext it cannot open.
 *
 * Hardening (review finding M4): invite ids are stored hashed; the first
 * account to fetch an invite claims it and nobody else can fetch it; the
 * wrapped blob is erased when the invite is accepted; invites expire in 24 h;
 * creating a new invite replaces the creator's previous unused one.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, requireAuth } from '../auth/session';
import { num } from '../env';
import { bytesOf, fromB64Url, hashToken, newId, toB64Url } from '../lib/crypto';
import { body, HttpError } from '../lib/http';
import { requireMember } from '../lib/members';
import { rateLimit } from '../lib/ratelimit';

const INVITE_HOURS = 24;
const NONCE_BYTES = 24;
const MAX_WRAPPED = 64 * 1024;

const B64 = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/));
const Wrapped = v.strictObject({
  nonce: v.pipe(B64, v.length(32)),
  ciphertext: v.pipe(B64, v.maxLength(Math.ceil((MAX_WRAPPED * 4) / 3))),
});
const InviteIdParam = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,64}$/));

function pack(w: v.InferOutput<typeof Wrapped>): Uint8Array {
  const nonce = fromB64Url(w.nonce);
  const ct = fromB64Url(w.ciphertext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return out;
}
function unpack(bytes: Uint8Array) {
  return {
    nonce: toB64Url(bytes.subarray(0, NONCE_BYTES)),
    ciphertext: toB64Url(bytes.subarray(NONCE_BYTES)),
  };
}
function inviteId(raw: string): string {
  const r = v.safeParse(InviteIdParam, raw);
  if (!r.success) throw new HttpError(404, 'not_found');
  return r.output;
}

export const invites = new Hono<AppEnv>();
invites.use('*', requireAuth);

invites.post('/', async (c) => {
  const uid = c.var.user.id;
  const input = await body(
    c,
    v.variant('kind', [
      v.strictObject({ kind: v.literal('partner'), space_id: v.string(), wrapped: Wrapped }),
      v.strictObject({ kind: v.literal('device'), wrapped: Wrapped }),
    ]),
  );
  await rateLimit(c.env, `invite:${uid}`, 20, 86_400);
  let spaceId: string | null = null;
  if (input.kind === 'partner') {
    await requireMember(c.env, input.space_id, uid);
    const members = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM memberships WHERE space_id = ?',
    )
      .bind(input.space_id)
      .first<{ n: number }>();
    if ((members?.n ?? 0) >= 2)
      throw new HttpError(409, 'space_full', 'This space already has two people.');
    spaceId = input.space_id;
  }
  const raw = newId();
  const now = Date.now();
  await c.env.DB.batch([
    // One live invite per creator, kind and space.
    c.env.DB.prepare(
      'DELETE FROM invites WHERE created_by = ? AND kind = ? AND space_id IS ? AND used_at IS NULL',
    ).bind(uid, input.kind, spaceId),
    c.env.DB.prepare(
      'INSERT INTO invites (id, space_id, kind, wrapped, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      await hashToken(raw),
      spaceId,
      input.kind,
      pack(input.wrapped),
      uid,
      now + INVITE_HOURS * 3_600_000,
    ),
  ]);
  return c.json({ id: raw, expires_at: now + INVITE_HOURS * 3_600_000 }, 201);
});

/** Fetching claims the invite for the caller; anyone else then gets 404. */
invites.get('/:id', async (c) => {
  const uid = c.var.user.id;
  await rateLimit(c.env, `invite-fetch:${uid}`, 30, 3600);
  const idHash = await hashToken(inviteId(c.req.param('id')));
  const row = await c.env.DB.prepare(
    `UPDATE invites SET claimed_by = ?1
      WHERE id = ?2 AND used_at IS NULL AND expires_at > ?3 AND (claimed_by IS NULL OR claimed_by = ?1)
        AND ((kind = 'device' AND created_by = ?1) OR (kind = 'partner' AND created_by != ?1))
      RETURNING kind, space_id, wrapped, created_by, expires_at`,
  )
    .bind(uid, idHash, Date.now())
    .first<{
      kind: 'partner' | 'device';
      space_id: string | null;
      wrapped: ArrayBuffer;
      created_by: string;
      expires_at: number;
    }>();
  if (!row)
    throw new HttpError(404, 'not_found', 'This invite has expired, was used, or isn’t for you.');
  if (row.kind === 'partner' && row.space_id) {
    const already = await c.env.DB.prepare(
      'SELECT 1 FROM memberships WHERE space_id = ? AND user_id = ?',
    )
      .bind(row.space_id, uid)
      .first();
    if (already) throw new HttpError(409, 'already_member');
  }
  return c.json({
    kind: row.kind,
    space_id: row.space_id,
    wrapped: unpack(bytesOf(row.wrapped)),
    inviter: row.created_by,
    expires_at: row.expires_at,
  });
});

/** Accepting adds the membership (partner) and erases the wrapped key blob. */
invites.post('/:id/accept', async (c) => {
  const uid = c.var.user.id;
  const idHash = await hashToken(inviteId(c.req.param('id')));
  const row = await c.env.DB.prepare(
    'SELECT kind, space_id FROM invites WHERE id = ? AND claimed_by = ? AND used_at IS NULL AND expires_at > ?',
  )
    .bind(idHash, uid, Date.now())
    .first<{ kind: 'partner' | 'device'; space_id: string | null }>();
  if (!row) throw new HttpError(404, 'not_found');
  const now = Date.now();
  // The invite is consumed (and its key blob erased) only if the join itself
  // succeeded: a full space or a capped joiner leaves the invite intact.
  const statements = [
    c.env.DB.prepare(
      `UPDATE invites SET used_at = ?1, wrapped = x''
        WHERE id = ?2 AND (kind = 'device' OR EXISTS (SELECT 1 FROM memberships WHERE space_id = ?3 AND user_id = ?4))`,
    ).bind(now, idHash, row.space_id, uid),
  ];
  if (row.kind === 'partner' && row.space_id) {
    // Space not full, and the joiner under their own space cap, checked atomically.
    statements.unshift(
      c.env.DB.prepare(
        `INSERT INTO memberships (space_id, user_id, role, joined_at)
         SELECT ?1, ?2, 'b', ?3
          WHERE (SELECT COUNT(*) FROM memberships WHERE space_id = ?1) < 2
            AND (SELECT COUNT(*) FROM memberships WHERE user_id = ?2) < ?4`,
      ).bind(row.space_id, uid, now, num(c.env.MAX_SPACES_PER_USER, 3)),
    );
  }
  const results = await c.env.DB.batch(statements);
  if (row.kind === 'partner' && !results[0]?.meta.changes) {
    throw new HttpError(
      409,
      'cannot_join',
      'This space is full, or you’re already in the most spaces allowed.',
    );
  }
  return c.json({ ok: true, space_id: row.space_id, role: row.kind === 'partner' ? 'b' : null });
});

invites.delete('/:id', async (c) => {
  const idHash = await hashToken(inviteId(c.req.param('id')));
  await c.env.DB.prepare('DELETE FROM invites WHERE id = ? AND created_by = ?')
    .bind(idHash, c.var.user.id)
    .run();
  return c.json({ ok: true });
});
