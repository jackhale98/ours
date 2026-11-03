// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import { type AppEnv, requireAuth } from '../auth/session';
import { num } from '../env';
import { newId } from '../lib/crypto';
import { HttpError } from '../lib/http';
import { requireMember } from '../lib/members';

export const spaces = new Hono<AppEnv>();
spaces.use('*', requireAuth);

/** Creates a space with the caller as member 'a'. */
spaces.post('/', async (c) => {
  const uid = c.var.user.id;
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?')
    .bind(uid)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= num(c.env.MAX_SPACES_PER_USER, 3))
    throw new HttpError(409, 'too_many_spaces');
  const id = newId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO spaces (id, created_at, seq) VALUES (?, ?, 0)').bind(id, now),
    c.env.DB.prepare(
      "INSERT INTO memberships (space_id, user_id, role, joined_at) VALUES (?, ?, 'a', ?)",
    ).bind(id, uid, now),
  ]);
  return c.json({ id, role: 'a' }, 201);
});

/** Leaves a space. Removes the caller's private records in it; deletes the space if nobody is left. */
spaces.delete('/:id/membership', async (c) => {
  const id = c.req.param('id');
  const uid = c.var.user.id;
  await requireMember(c.env, id, uid);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM records WHERE space_id = ? AND owner_user_id = ?').bind(id, uid),
    c.env.DB.prepare('DELETE FROM memberships WHERE space_id = ? AND user_id = ?').bind(id, uid),
    c.env.DB.prepare(
      'DELETE FROM spaces WHERE id = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE space_id = ?)',
    ).bind(id, id),
    c.env.DB.prepare(
      'UPDATE spaces SET bytes = (SELECT COALESCE(SUM(length(ciphertext)), 0) FROM records WHERE space_id = ?) WHERE id = ?',
    ).bind(id, id),
  ]);
  return c.json({ ok: true });
});
