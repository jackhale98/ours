// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import { type AppEnv, requireAuth } from '../auth/session';
import { num } from '../env';
import { newId } from '../lib/crypto';
import { HttpError } from '../lib/http';
import { requireMember } from '../lib/members';
import { SPACE_BYTES_SQL } from '../lib/quota';

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
  } catch {
    throw new HttpError(409, 'too_many_spaces');
  }
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
    c.env.DB.prepare(`UPDATE spaces SET bytes = ${SPACE_BYTES_SQL} WHERE id = ?`).bind(id, id),
  ]);
  return c.json({ ok: true });
});
