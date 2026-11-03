// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Rate limiting. Uses the Workers Rate Limiting binding when configured,
 * otherwise a fixed-window counter in D1 (self-hosting without the binding,
 * and tests).
 */
import type { Env } from '../env';
import { HttpError } from './http';

/** Per-isolate fallback salt, used only if RATE_LIMIT_SALT isn't configured. */
const isolateSalt = crypto.getRandomValues(new Uint8Array(16)).join('.');

/**
 * Keys are hashed with a secret salt before they touch the database, so no IP
 * address or email address is ever stored for rate limiting. Rows are deleted
 * by the hourly cleanup after a day.
 */
async function opaqueKey(env: Env, key: string): Promise<string> {
  const data = new TextEncoder().encode(`${env.RATE_LIMIT_SALT ?? isolateSalt}|${key}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function rateLimit(
  env: Env,
  rawKey: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const key = await opaqueKey(env, rawKey);
  if (env.RL_AUTH && windowSeconds === 60) {
    const { success } = await env.RL_AUTH.limit({ key });
    if (!success) {
      throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in a minute.');
    }
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const window = now - (now % windowSeconds);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`,
  )
    .bind(key, window)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) {
    throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.');
  }
}
