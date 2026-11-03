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
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; session: AuthSession };
};

/** Creates a device (if needed) and a session. Returns the raw token, shown once. */
export async function createSession(
  env: Env,
  userId: string,
  deviceLabel: string,
  deviceId?: string,
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
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= num(env.MAX_DEVICES_PER_USER, 10)) {
      throw new HttpError(
        409,
        'too_many_devices',
        'Remove a device in Privacy before adding another.',
      );
    }
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
      'INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(await hashToken(token), userId, device, now, expires, now),
    env.DB.prepare('UPDATE users SET last_active = ? WHERE id = ?').bind(now, userId),
  ]);
  return { token, device_id: device, expires_at: expires };
}

/** Requires `Authorization: Bearer <token>`; sets c.var.user and c.var.session. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match?.[1]) throw new HttpError(401, 'unauthenticated');
  const tokenHash = await hashToken(match[1]);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.token_hash, s.device_id, s.expires_at, s.last_seen, u.id, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      token_hash: string;
      device_id: string;
      expires_at: number;
      last_seen: number | null;
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
  c.set('session', { token_hash: row.token_hash, device_id: row.device_id });
  await next();
};
