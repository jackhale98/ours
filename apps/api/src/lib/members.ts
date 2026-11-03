// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from '../env';
import { HttpError } from './http';

/** The caller's role in a space ('a' created it, 'b' joined). 404 if not a member, so space ids don't leak. */
export async function requireMember(env: Env, spaceId: string, userId: string): Promise<'a' | 'b'> {
  const row = await env.DB.prepare(
    'SELECT role FROM memberships WHERE space_id = ? AND user_id = ?',
  )
    .bind(spaceId, userId)
    .first<{ role: 'a' | 'b' }>();
  if (!row) throw new HttpError(404, 'not_found');
  return row.role;
}
