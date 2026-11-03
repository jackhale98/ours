// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Delivery: wraps an end-to-end encrypted notification for each of a user's
 * push subscriptions and sends it. The Worker never sees notification text:
 * `payload` is `nonce || ciphertext` sealed with the space key on the
 * sender's device (core `sealNotification`).
 */
import type { Env } from '../env';
import { bytesOf, toB64Url } from '../lib/crypto';
import { encryptPush } from './encrypt';
import { isPushEndpoint, type VapidKeys, vapidAuthorization } from './vapid';

/** Raw bytes of nonce || ciphertext accepted per notification (fits the 4 KB push limit once wrapped). */
export const MAX_PAYLOAD_BYTES = 2800;
/**
 * Local end-to-end tests only (EMAIL_PROVIDER 'dev-outbox', same switch as the
 * email outbox): pushes are recorded, fully encrypted, instead of sent, and
 * served at GET /dev/pushes on localhost.
 */
export const devPushes: { endpoint: string; body: string; ttl: string; urgency: string }[] = [];

/** A subscription that fails this many times in a row (other than 404/410) is dropped. */
const MAX_FAILURES = 10;

export interface Sealed {
  space_id: string;
  key_version: number;
  /** nonce || ciphertext */
  payload: Uint8Array;
}

export function vapidKeys(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || env.APP_URL || 'https://github.com/jackhale98/ours',
  };
}

/** What the service worker receives after the browser removes the Web Push layer. */
export function wrap(message: Sealed): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      s: message.space_id,
      k: message.key_version,
      p: toB64Url(message.payload),
    }),
  );
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends to every subscription of `userId`. Returns how many push services accepted it. */
export async function deliver(
  env: Env,
  userId: string,
  message: Sealed,
  opts: { ttlSeconds: number; urgency: 'normal' | 'high' },
  now = Date.now(),
): Promise<number> {
  const keys = vapidKeys(env);
  if (!keys) return 0;
  const subs = await env.DB.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ?',
  )
    .bind(userId)
    .all<SubRow>();
  const body = wrap(message);
  let delivered = 0;
  const updates: D1PreparedStatement[] = [];
  for (const sub of subs.results) {
    if (!isPushEndpoint(sub.endpoint)) {
      updates.push(env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id));
      continue;
    }
    let status = 0;
    try {
      const encrypted = await encryptPush(body, b64(sub.p256dh), b64(sub.auth));
      if (env.EMAIL_PROVIDER === 'dev-outbox') {
        devPushes.push({
          endpoint: sub.endpoint,
          body: toB64Url(encrypted),
          ttl: String(Math.max(0, Math.floor(opts.ttlSeconds))),
          urgency: opts.urgency,
        });
        if (devPushes.length > 50) devPushes.shift();
        delivered++;
        continue;
      }
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidAuthorization(sub.endpoint, keys, now),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(Math.max(0, Math.floor(opts.ttlSeconds))),
          Urgency: opts.urgency,
        },
        body: encrypted,
        redirect: 'manual',
      });
      status = res.status;
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      delivered++;
      updates.push(
        env.DB.prepare('UPDATE push_subs SET last_ok = ?, failures = 0 WHERE id = ?').bind(
          now,
          sub.id,
        ),
      );
    } else if (status === 404 || status === 410) {
      // The browser dropped this subscription.
      updates.push(env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id));
    } else {
      updates.push(
        env.DB.prepare('UPDATE push_subs SET failures = failures + 1 WHERE id = ?').bind(sub.id),
      );
    }
  }
  if (updates.length) {
    updates.push(
      env.DB.prepare('DELETE FROM push_subs WHERE user_id = ? AND failures >= ?').bind(
        userId,
        MAX_FAILURES,
      ),
    );
    await env.DB.batch(updates);
  }
  return delivered;
}

function b64(text: string): Uint8Array {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/**
 * If `now` falls in the user's quiet hours, the instant they end; else null.
 * Quiet hours are minutes after local midnight in `tz`, and may wrap midnight.
 */
export function quietUntil(
  now: number,
  quiet: { start: number | null; end: number | null; tz: string | null },
): number | null {
  const { start, end, tz } = quiet;
  if (start === null || end === null || !tz || start === end) return null;
  let minutes: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    minutes = h * 60 + m;
  } catch {
    return null;
  }
  const inside =
    start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inside) return null;
  const wait = (end - minutes + 1440) % 1440;
  // Round down to the start of the current minute, then add the wait.
  return now - (now % 60_000) + wait * 60_000;
}

/** Cron: sends due reminders and notifications held for quiet hours. */
export async function sendDue(env: Env, now = Date.now()): Promise<number> {
  if (!vapidKeys(env)) return 0;
  const due = await env.DB.prepare(
    `SELECT r.id, r.space_id, r.target_user_id, r.key_version, r.payload, r.fire_at
       FROM reminders r
      WHERE r.fire_at <= ?
      ORDER BY r.fire_at
      LIMIT 100`,
  )
    .bind(now)
    .all<{
      id: string;
      space_id: string;
      target_user_id: string;
      key_version: number;
      payload: ArrayBuffer;
      fire_at: number;
    }>();
  if (!due.results.length) return 0;
  // Claim first, so an overlapping run cannot send the same one twice.
  const claimed = await env.DB.batch(
    due.results.map((r) => env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id)),
  );
  let sent = 0;
  for (const [i, r] of due.results.entries()) {
    if (!claimed[i]?.meta.changes) continue;
    // Too late to be useful, or the target left the space.
    if (r.fire_at < now - 3_600_000) continue;
    const member = await env.DB.prepare(
      'SELECT 1 FROM memberships WHERE space_id = ? AND user_id = ?',
    )
      .bind(r.space_id, r.target_user_id)
      .first();
    if (!member) continue;
    sent += await deliver(
      env,
      r.target_user_id,
      { space_id: r.space_id, key_version: r.key_version, payload: bytesOf(r.payload) },
      { ttlSeconds: 3600, urgency: 'high' },
      now,
    );
  }
  return sent;
}
