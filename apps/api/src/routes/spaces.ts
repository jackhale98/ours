// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, requireAuth } from '../auth/session';
import { num } from '../env';
import { newId } from '../lib/crypto';
import { body, HttpError } from '../lib/http';
import { requireMember } from '../lib/members';
import { isQuotaAbort, SPACE_BYTES_SQL } from '../lib/quota';
import { rateLimit } from '../lib/ratelimit';

export const spaces = new Hono<AppEnv>();
spaces.use('*', requireAuth);

/** Creates a space with the caller as member 'a'. The cap is enforced atomically in SQL. */
spaces.post('/', async (c) => {
  const uid = c.var.user.id;
  const max = num(c.env.MAX_SPACES_PER_USER, 3);
  const id = newId();
  const now = Date.now();
  // The membership insert is conditional on the cap, and the guard row aborts
  // (rolls back) the whole batch, including the space, when over it.
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO quota_guard (x) SELECT NULL WHERE (SELECT COUNT(*) FROM memberships WHERE user_id = ?) >= ?',
      ).bind(uid, max),
      c.env.DB.prepare('INSERT INTO spaces (id, created_at, seq) VALUES (?, ?, 0)').bind(id, now),
      c.env.DB.prepare(
        "INSERT INTO memberships (space_id, user_id, role, joined_at) VALUES (?, ?, 'a', ?)",
      ).bind(id, uid, now),
    ]);
  } catch (err) {
    if (isQuotaAbort(err)) throw new HttpError(409, 'too_many_spaces');
    throw err;
  }
  return c.json({ id, role: 'a' }, 201);
});

/**
 * Key rotation (ADR 0013): raises the minimum key versions for this space and
 * for the caller's personal records by exactly one, from the versions the
 * caller says it is rotating from. Old versions stay readable but can no
 * longer be written. A concurrent rotation by the partner gets 409.
 */
spaces.post('/:id/rotate', async (c) => {
  const id = c.req.param('id');
  const uid = c.var.user.id;
  const Version = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000));
  const input = await body(c, v.strictObject({ space_from: Version, personal_from: Version }));
  await requireMember(c.env, id, uid);
  await rateLimit(c.env, `rotate:${uid}`, 10, 86_400);
  const cur = await c.env.DB.prepare(
    `SELECT (SELECT key_version FROM spaces WHERE id = ?1) AS space,
            (SELECT personal_key_version FROM users WHERE id = ?2) AS personal`,
  )
    .bind(id, uid)
    .first<{ space: number; personal: number }>();
  if (cur?.space !== input.space_from || cur?.personal !== input.personal_from)
    throw new HttpError(409, 'rotation_conflict', 'Keys changed on another device. Try again.');
  const [spaceRes, userRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE spaces SET key_version = ?2 + 1, rotated_rev = seq WHERE id = ?1 AND key_version = ?2',
    ).bind(id, input.space_from),
    c.env.DB.prepare(
      'UPDATE users SET personal_key_version = ?2 + 1 WHERE id = ?1 AND personal_key_version = ?2',
    ).bind(uid, input.personal_from),
  ]);
  if (!spaceRes?.meta.changes || !userRes?.meta.changes)
    throw new HttpError(409, 'rotation_conflict', 'Keys changed on another device. Try again.');
  const after = await c.env.DB.prepare('SELECT key_version, rotated_rev FROM spaces WHERE id = ?')
    .bind(id)
    .first<{ key_version: number; rotated_rev: number }>();
  return c.json({
    key_version: after?.key_version,
    rotated_rev: after?.rotated_rev,
    personal_key_version: input.personal_from + 1,
  });
});

/** Leaves a space. Removes the caller's private records in it; deletes the space if nobody is left. */
spaces.delete('/:id/membership', async (c) => {
  const id = c.req.param('id');
  const uid = c.var.user.id;
  await requireMember(c.env, id, uid);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM records WHERE space_id = ? AND owner_user_id = ?').bind(id, uid),
    c.env.DB.prepare('DELETE FROM memberships WHERE space_id = ? AND user_id = ?').bind(id, uid),
    // Their reminders, and notifications they sent that are held for quiet hours.
    c.env.DB.prepare(
      'DELETE FROM reminders WHERE space_id = ? AND (target_user_id = ? OR sender_user_id = ?)',
    ).bind(id, uid, uid),
    c.env.DB.prepare(
      'DELETE FROM spaces WHERE id = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE space_id = ?)',
    ).bind(id, id),
    c.env.DB.prepare(`UPDATE spaces SET bytes = ${SPACE_BYTES_SQL} WHERE id = ?`).bind(id, id),
  ]);
  return c.json({ ok: true });
});
