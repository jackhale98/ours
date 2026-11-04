// SPDX-License-Identifier: AGPL-3.0-or-later
/** The signed-in account: profile, devices, spaces; device removal; account deletion. */
import { Hono } from 'hono';
import { type AppEnv, requireAuth } from '../auth/session';
import { deleteAccount } from '../lib/accounts';
import { HttpError } from '../lib/http';

export const me = new Hono<AppEnv>();

me.get('/me', requireAuth, async (c) => {
  const user = c.var.user;
  const [profile, devices, spaces, passkeys, kids] = await c.env.DB.batch([
    c.env.DB.prepare(
      'SELECT id, email, created_at, personal_key_version FROM users WHERE id = ?',
    ).bind(user.id),
    c.env.DB.prepare(
      'SELECT id, label, created_at, last_seen FROM devices WHERE user_id = ? ORDER BY created_at',
    ).bind(user.id),
    c.env.DB.prepare(
      `SELECT m.space_id, m.role, m.joined_at, s.key_version, s.rotated_rev, s.rotated_by, s.rotated_at,
              (SELECT json_group_array(json_object('user_id', o.user_id, 'role', o.role, 'joined_at', o.joined_at,
                                                   'key_version', o.key_version))
                 FROM memberships o WHERE o.space_id = m.space_id) AS members
         FROM memberships m JOIN spaces s ON s.id = m.space_id
        WHERE m.user_id = ? ORDER BY m.joined_at`,
    ).bind(user.id),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(user.id),
    // Fingerprints of the keys behind each version (review 0005, H1).
    c.env.DB.prepare(
      `SELECT scope, owner, version, kid FROM key_ids
        WHERE (scope = 'user' AND owner = ?1)
           OR (scope = 'space' AND owner IN (SELECT space_id FROM memberships WHERE user_id = ?1))
        ORDER BY version`,
    ).bind(user.id),
  ]);
  const kidRows = (kids?.results ?? []) as {
    scope: 'space' | 'user';
    owner: string;
    version: number;
    kid: string;
  }[];
  const kidsOf = (scope: 'space' | 'user', owner: string) =>
    kidRows
      .filter((k) => k.scope === scope && k.owner === owner)
      .map(({ version, kid }) => ({ version, kid }));
  const session = c.var.session;
  return c.json({
    user: { ...(profile?.results[0] as object), personal_kids: kidsOf('user', user.id) },
    device_id: session.device_id,
    /** When this session last signed in or confirmed with a passkey. */
    signed_in_at: Math.max(session.created_at, session.reauth_at ?? 0),
    /** Whether passkeys may be set up to unlock keys (ADR 0015). */
    passkey_unlock: c.env.PASSKEY_UNLOCK === 'on',
    devices: devices?.results ?? [],
    spaces: ((spaces?.results ?? []) as Record<string, unknown>[]).map((s) => ({
      ...s,
      members: JSON.parse(String(s.members)),
      kids: kidsOf('space', String(s.space_id)),
    })),
    passkeys: (passkeys?.results[0] as { n: number } | undefined)?.n ?? 0,
  });
});

/** Revokes a device: its sessions end immediately. */
me.delete('/devices/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?')
    .bind(id, c.var.user.id)
    .run();
  if (!result.meta.changes) throw new HttpError(404, 'not_found');
  return c.json({ ok: true });
});

/**
 * Deletes the account and everything only this user can read. Shared records
 * stay with the partner; a space with no members left is deleted entirely.
 */
me.delete('/me', requireAuth, async (c) => {
  await deleteAccount(c.env, c.var.user.id, c.var.user.email);
  return c.json({ ok: true });
});
