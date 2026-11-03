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
  /** Which key sealed it: the space key (partner notifications) or the recipient's personal key (reminders). */
  scope: 'space' | 'user';
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
      c: message.scope === 'user' ? 'u' : 's',
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

export interface DeliveryResult {
  /** Push services that accepted it. */
  delivered: number;
  /** Some sends failed in a way worth retrying (network, 429, 5xx). */
  transient: boolean;
  /** Outgoing requests made (Workers cap subrequests per invocation). */
  requests: number;
}

/** Sends to every subscription of `userId`, making at most `budget` requests. */
export async function deliver(
  env: Env,
  userId: string,
  message: Sealed,
  opts: { ttlSeconds: number; urgency: 'normal' | 'high'; budget?: number },
  now = Date.now(),
): Promise<DeliveryResult> {
  const result: DeliveryResult = { delivered: 0, transient: false, requests: 0 };
  const keys = vapidKeys(env);
  if (!keys) return result;
  const subs = await env.DB.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ?',
  )
    .bind(userId)
    .all<SubRow>();
  const body = wrap(message);
  const budget = opts.budget ?? 20;
  const updates: D1PreparedStatement[] = [];
  for (const sub of subs.results) {
    if (!isPushEndpoint(sub.endpoint)) {
      updates.push(env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id));
      continue;
    }
    if (result.requests >= budget) {
      result.transient = true;
      break;
    }
    let status = 0;
    try {
      const encrypted = await encryptPush(body, b64(sub.p256dh), b64(sub.auth));
      result.requests++;
      if (env.EMAIL_PROVIDER === 'dev-outbox') {
        devPushes.push({
          endpoint: sub.endpoint,
          body: toB64Url(encrypted),
          ttl: String(Math.max(0, Math.floor(opts.ttlSeconds))),
          urgency: opts.urgency,
        });
        if (devPushes.length > 50) devPushes.shift();
        status = 201;
      } else {
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
      }
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      result.delivered++;
      updates.push(
        env.DB.prepare('UPDATE push_subs SET last_ok = ?, failures = 0 WHERE id = ?').bind(
          now,
          sub.id,
        ),
      );
    } else if (status === 404 || status === 410) {
      // The browser dropped this subscription.
      updates.push(env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id));
    } else if (status === 400 || status === 403 || status === 413) {
      // A definite rejection of this subscription (bad keys, wrong VAPID key).
      // Network errors, 429 and 5xx say nothing about the subscription.
      updates.push(
        env.DB.prepare('UPDATE push_subs SET failures = failures + 1 WHERE id = ?').bind(sub.id),
      );
    } else {
      result.transient = true;
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
  return result;
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

/** Rows per user per run, rows per run, and outgoing requests per run (Workers Free allows 50 subrequests). */
const PER_USER_PER_RUN = 5;
const ROWS_PER_RUN = 40;
const REQUESTS_PER_RUN = 40;
/** A claimed row that was not finished is retried after this long, up to MAX_ATTEMPTS times. */
const CLAIM_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
/** Later than this, a reminder is no use: dropped unsent. */
const TOO_LATE_MS = 3_600_000;

/**
 * Cron: sends due reminders and notifications held for quiet hours.
 * Fair across users (a few rows each per run), bounded per run, and
 * retried: rows are claimed, and deleted only once handled.
 */
export async function sendDue(env: Env, now = Date.now()): Promise<number> {
  if (!vapidKeys(env)) return 0;
  await env.DB.prepare('DELETE FROM reminders WHERE fire_at < ? OR attempts >= ?')
    .bind(now - TOO_LATE_MS, MAX_ATTEMPTS)
    .run();
  const due = await env.DB.prepare(
    `SELECT id, space_id, target_user_id, key_version, scope, payload FROM (
       SELECT r.*, ROW_NUMBER() OVER (PARTITION BY target_user_id ORDER BY fire_at) AS n
         FROM reminders r
        WHERE fire_at <= ?1 AND (claimed_at IS NULL OR claimed_at < ?2)
     ) WHERE n <= ?3
     ORDER BY fire_at
     LIMIT ?4`,
  )
    .bind(now, now - CLAIM_MS, PER_USER_PER_RUN, ROWS_PER_RUN)
    .all<{
      id: string;
      space_id: string;
      target_user_id: string;
      key_version: number;
      scope: 'space' | 'user';
      payload: ArrayBuffer;
    }>();
  if (!due.results.length) return 0;
  // Claim first, so an overlapping run cannot send the same one twice.
  const claimed = await env.DB.batch(
    due.results.map((r) =>
      env.DB.prepare(
        'UPDATE reminders SET claimed_at = ?1, attempts = attempts + 1 WHERE id = ?2 AND (claimed_at IS NULL OR claimed_at < ?3)',
      ).bind(now, r.id, now - CLAIM_MS),
    ),
  );
  let sent = 0;
  let requests = 0;
  const done: string[] = [];
  const release: string[] = [];
  for (const [i, r] of due.results.entries()) {
    if (!claimed[i]?.meta.changes) continue;
    if (requests >= REQUESTS_PER_RUN) {
      release.push(r.id);
      continue;
    }
    const member = await env.DB.prepare(
      'SELECT 1 FROM memberships WHERE space_id = ? AND user_id = ?',
    )
      .bind(r.space_id, r.target_user_id)
      .first();
    if (!member) {
      done.push(r.id);
      continue;
    }
    const result = await deliver(
      env,
      r.target_user_id,
      {
        space_id: r.space_id,
        key_version: r.key_version,
        scope: r.scope,
        payload: bytesOf(r.payload),
      },
      { ttlSeconds: 3600, urgency: 'high', budget: REQUESTS_PER_RUN - requests },
      now,
    );
    requests += result.requests;
    sent += result.delivered;
    // Delivered to at least one device, or nothing worth retrying: finished.
    if (result.delivered > 0 || !result.transient) done.push(r.id);
  }
  const finish = [
    ...done.map((id) => env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(id)),
    // Not attempted this run for lack of budget: unclaim without using up an attempt.
    ...release.map((id) =>
      env.DB.prepare(
        'UPDATE reminders SET claimed_at = NULL, attempts = attempts - 1 WHERE id = ?',
      ).bind(id),
    ),
  ];
  if (finish.length) await env.DB.batch(finish);
  return sent;
}
