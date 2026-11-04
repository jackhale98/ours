// SPDX-License-Identifier: AGPL-3.0-or-later
/** Bearer-token sessions. Tokens are random 256-bit values stored only as hashes. */
import type { MiddlewareHandler } from 'hono';
import { type Env, num } from '../env';
import { hashToken, newId, newToken } from '../lib/crypto';
import { HttpError } from '../lib/http';

export const SESSION_DAYS = 90;
const DAY = 86_400_000;

export interface AuthUser {
  id: string;
  email: string;
}
export interface AuthSession {
  token_hash: string;
  device_id: string;
  created_at: number;
  /** Last passkey confirmation in this session (actions that need a recent sign-in). */
  reauth_at?: number | null;
  /** The passkey this session signed in or last confirmed with. */
  passkey_id?: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; session: AuthSession };
};

/**
 * Makes room for a new device. Never fails at the cap (that would lock people
 * out): devices without a live session go first, then the least recently seen
 * (its sessions end). Users see and remove devices in Privacy.
 */
async function makeRoomForDevice(env: Env, userId: string, now: number): Promise<void> {
  const max = num(env.MAX_DEVICES_PER_USER, 10);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM devices WHERE user_id = ?1
         AND NOT EXISTS (SELECT 1 FROM sessions WHERE device_id = devices.id AND expires_at > ?2)`,
    ).bind(userId, now),
    env.DB.prepare(
      `DELETE FROM devices WHERE id IN (
         SELECT id FROM devices WHERE user_id = ?1
          ORDER BY COALESCE(last_seen, created_at) ASC
          LIMIT MAX(0, (SELECT COUNT(*) FROM devices WHERE user_id = ?1) - ?2 + 1))`,
    ).bind(userId, max),
  ]);
}

/** Creates a device (if needed) and a session. Returns the raw token, shown once. */
export async function createSession(
  env: Env,
  userId: string,
  deviceLabel: string,
  deviceId?: string,
  passkeyId?: string,
): Promise<{ token: string; device_id: string; expires_at: number }> {
  const now = Date.now();
  let device = deviceId;
  if (device) {
    const owned = await env.DB.prepare('SELECT 1 FROM devices WHERE id = ? AND user_id = ?')
      .bind(device, userId)
      .first();
    if (!owned) device = undefined;
  }
  if (!device) {
    await makeRoomForDevice(env, userId, now);
    device = newId();
    await env.DB.prepare(
      'INSERT INTO devices (id, user_id, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(device, userId, deviceLabel.slice(0, 60), now, now)
      .run();
  }
  const token = newToken();
  const expires = now + SESSION_DAYS * DAY;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at, last_seen, passkey_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(await hashToken(token), userId, device, now, expires, now, passkeyId ?? null),
    env.DB.prepare('UPDATE users SET last_active = ? WHERE id = ?').bind(now, userId),
  ]);
  return { token, device_id: device, expires_at: expires };
}

/** Ends a session; its device goes too if no other session uses it. */
export async function endSession(env: Env, session: AuthSession): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash),
    env.DB.prepare(
      'DELETE FROM devices WHERE id = ? AND NOT EXISTS (SELECT 1 FROM sessions WHERE device_id = ?)',
    ).bind(session.device_id, session.device_id),
  ]);
}

/** Requires `Authorization: Bearer <token>`; sets c.var.user and c.var.session. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match?.[1]) throw new HttpError(401, 'unauthenticated');
  const tokenHash = await hashToken(match[1]);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.token_hash, s.device_id, s.created_at, s.expires_at, s.last_seen, s.reauth_at, s.passkey_id, u.id, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      token_hash: string;
      device_id: string;
      created_at: number;
      expires_at: number;
      last_seen: number | null;
      reauth_at: number | null;
      passkey_id: string | null;
      id: string;
      email: string;
    }>();
  if (!row || row.expires_at <= now) throw new HttpError(401, 'unauthenticated');
  // Sliding expiry and activity, written at most once an hour per session.
  if (!row.last_seen || now - row.last_seen > 3_600_000) {
    c.executionCtx.waitUntil(
      c.env.DB.batch([
        c.env.DB.prepare(
          'UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?',
        ).bind(now, now + SESSION_DAYS * DAY, row.token_hash),
        c.env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now, row.device_id),
        c.env.DB.prepare('UPDATE users SET last_active = ? WHERE id = ?').bind(now, row.id),
      ]),
    );
  }
  c.set('user', { id: row.id, email: row.email });
  c.set('session', {
    token_hash: row.token_hash,
    device_id: row.device_id,
    created_at: row.created_at,
    reauth_at: row.reauth_at,
    passkey_id: row.passkey_id,
  });
  await next();
};
