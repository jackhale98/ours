// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notifications (phase 5, ADR 0010).
 *
 * - A device subscribes with its browser push address; one per device.
 * - A device asks the server to notify the partner (or the user's own other
 *   devices) with a payload it sealed with the space key. If the target is in
 *   quiet hours the payload is held until they end.
 * - A device replaces its own list of upcoming reminders (sealed the same
 *   way); the cron sends each at its time.
 *
 * The server learns who notifies whom and when, and reminder times. It never
 * learns the text.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, requireAuth } from '../auth/session';
import { num } from '../env';
import { fromB64Url, newId } from '../lib/crypto';
import { body, HttpError } from '../lib/http';
import { requireMember } from '../lib/members';
import { rateLimit } from '../lib/ratelimit';
import { deliver, MAX_PAYLOAD_BYTES, quietUntil, vapidKeys } from '../push/send';
import { isPushEndpoint } from '../push/vapid';

export const MAX_REMINDERS = 64;
const HORIZON_MS = 8 * 86_400_000;
/** Held notifications per sender and target during quiet hours. */
const MAX_DEFERRED_PER_TARGET = 20;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

const B64 = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/));
const Id = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const KeyVersion = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000));
const SealedPayload = v.strictObject({
  nonce: v.pipe(B64, v.length(32)),
  ciphertext: v.pipe(B64, v.maxLength(Math.ceil(((MAX_PAYLOAD_BYTES - NONCE_BYTES) * 4) / 3))),
});

function pack(p: v.InferOutput<typeof SealedPayload>): Uint8Array {
  let nonce: Uint8Array;
  let ct: Uint8Array;
  try {
    nonce = fromB64Url(p.nonce);
    ct = fromB64Url(p.ciphertext);
  } catch {
    throw new HttpError(422, 'invalid', 'Malformed payload');
  }
  if (nonce.length !== NONCE_BYTES || ct.length < TAG_BYTES)
    throw new HttpError(422, 'invalid', 'Malformed payload');
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return out;
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const push = new Hono<AppEnv>();
push.use('*', requireAuth);

/** The VAPID public key (null when push is not set up) and the user's quiet hours. */
push.get('/config', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT quiet_start, quiet_end, quiet_tz FROM users WHERE id = ?',
  )
    .bind(c.var.user.id)
    .first<{ quiet_start: number | null; quiet_end: number | null; quiet_tz: string | null }>();
  const subscribed = await c.env.DB.prepare('SELECT 1 FROM push_subs WHERE device_id = ?')
    .bind(c.var.session.device_id)
    .first();
  return c.json({
    key: vapidKeys(c.env)?.publicKey ?? null,
    subscribed: !!subscribed,
    quiet:
      row?.quiet_start != null && row.quiet_end != null && row.quiet_tz
        ? { start: row.quiet_start, end: row.quiet_end, tz: row.quiet_tz }
        : null,
  });
});

push.put('/subscription', async (c) => {
  if (!vapidKeys(c.env)) throw new HttpError(501, 'push_unavailable');
  const input = await body(
    c,
    v.strictObject({
      endpoint: v.pipe(v.string(), v.maxLength(1024)),
      p256dh: v.pipe(B64, v.length(87)), // 65-byte uncompressed P-256 point
      auth: v.pipe(B64, v.length(22)), // 16-byte secret
    }),
  );
  if (!isPushEndpoint(input.endpoint))
    throw new HttpError(422, 'invalid', 'Not a browser push address');
  if (fromB64Url(input.p256dh)[0] !== 4) throw new HttpError(422, 'invalid', 'Bad key');
  await rateLimit(c.env, `push-sub:${c.var.user.id}`, 30, 3600);
  const device = c.var.session.device_id;
  // The same browser can move between accounts, but only by proving it holds
  // the subscription (same keys). A leaked endpoint alone can't take it over.
  const existing = await c.env.DB.prepare(
    'SELECT user_id, p256dh, auth FROM push_subs WHERE endpoint = ?',
  )
    .bind(input.endpoint)
    .first<{ user_id: string; p256dh: string; auth: string }>();
  if (
    existing &&
    existing.user_id !== c.var.user.id &&
    (existing.p256dh !== input.p256dh || existing.auth !== input.auth)
  )
    throw new HttpError(409, 'endpoint_in_use');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? OR device_id = ?').bind(
      input.endpoint,
      device,
    ),
    c.env.DB.prepare(
      'INSERT INTO push_subs (id, user_id, device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(newId(), c.var.user.id, device, input.endpoint, input.p256dh, input.auth, Date.now()),
  ]);
  return c.json({ ok: true });
});

push.delete('/subscription', async (c) => {
  await c.env.DB.prepare('DELETE FROM push_subs WHERE device_id = ? AND user_id = ?')
    .bind(c.var.session.device_id, c.var.user.id)
    .run();
  return c.json({ ok: true });
});

push.put('/quiet', async (c) => {
  const Minute = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1439));
  const input = await body(
    c,
    v.union([
      v.strictObject({ start: Minute, end: Minute, tz: v.pipe(v.string(), v.maxLength(64)) }),
      v.null(),
    ]),
  );
  if (input && !isTimeZone(input.tz)) throw new HttpError(422, 'invalid', 'Unknown time zone');
  await c.env.DB.prepare(
    'UPDATE users SET quiet_start = ?, quiet_end = ?, quiet_tz = ? WHERE id = ?',
  )
    .bind(input?.start ?? null, input?.end ?? null, input?.tz ?? null, c.var.user.id)
    .run();
  return c.json({ ok: true });
});

/** Notify the partner (or my own other devices) now, or when their quiet hours end. */
push.post('/notify', async (c) => {
  const uid = c.var.user.id;
  const input = await body(
    c,
    v.strictObject({
      space_id: Id,
      key_version: KeyVersion,
      to: v.picklist(['partner', 'me']),
      payload: SealedPayload,
      ttl_seconds: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(60), v.maxValue(7 * 86_400)),
      ),
    }),
  );
  await requireMember(c.env, input.space_id, uid);
  await rateLimit(c.env, `notify:${uid}`, num(c.env.MAX_PUSHES_PER_HOUR, 60), 3600);
  if (!vapidKeys(c.env)) return c.json({ sent: 0, deferred: 0 });
  const payload = pack(input.payload);
  const targets =
    input.to === 'me'
      ? [{ user_id: uid, quiet_start: null, quiet_end: null, quiet_tz: null }]
      : (
          await c.env.DB.prepare(
            `SELECT u.id AS user_id, u.quiet_start, u.quiet_end, u.quiet_tz
               FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.space_id = ? AND m.user_id != ?`,
          )
            .bind(input.space_id, uid)
            .all<{
              user_id: string;
              quiet_start: number | null;
              quiet_end: number | null;
              quiet_tz: string | null;
            }>()
        ).results;
  const now = Date.now();
  const ttl = input.ttl_seconds ?? 86_400;
  let deferred = 0;
  const sendNow: string[] = [];
  for (const t of targets) {
    const until = quietUntil(now, { start: t.quiet_start, end: t.quiet_end, tz: t.quiet_tz });
    if (until === null) {
      sendNow.push(t.user_id);
      continue;
    }
    // At most MAX_DEFERRED per sender and target: a new one replaces the oldest.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM reminders WHERE id IN (
           SELECT id FROM reminders
            WHERE target_user_id = ?1 AND sender_user_id = ?2 AND kind = 'deferred'
            ORDER BY created_at DESC LIMIT -1 OFFSET ?3)`,
      ).bind(t.user_id, uid, MAX_DEFERRED_PER_TARGET - 1),
      c.env.DB.prepare(
        `INSERT INTO reminders (id, space_id, target_user_id, sender_user_id, kind, scope, fire_at, key_version, payload, created_at)
         VALUES (?, ?, ?, ?, 'deferred', 'space', ?, ?, ?, ?)`,
      ).bind(newId(), input.space_id, t.user_id, uid, until, input.key_version, payload, now),
    ]);
    deferred++;
  }
  // Sending happens after the response, so its timing reveals nothing to the caller.
  c.executionCtx.waitUntil(
    Promise.all(
      sendNow.map((target) =>
        deliver(
          c.env,
          target,
          { space_id: input.space_id, key_version: input.key_version, scope: 'space', payload },
          { ttlSeconds: ttl, urgency: 'normal' },
          now,
        ),
      ),
    ),
  );
  return c.json({ queued: sendNow.length, deferred });
});

/** Replace my upcoming reminders in a space. An empty list clears them. */
push.put('/reminders', async (c) => {
  const uid = c.var.user.id;
  const input = await body(
    c,
    v.strictObject({
      space_id: Id,
      items: v.pipe(
        v.array(
          v.strictObject({
            fire_at: v.pipe(v.number(), v.integer(), v.minValue(0)),
            key_version: KeyVersion,
            payload: SealedPayload,
          }),
        ),
        v.maxLength(MAX_REMINDERS),
      ),
    }),
  );
  await requireMember(c.env, input.space_id, uid);
  await rateLimit(c.env, `reminders:${uid}`, 120, 3600);
  const now = Date.now();
  for (const item of input.items) {
    if (item.fire_at > now + HORIZON_MS)
      throw new HttpError(422, 'invalid', 'Reminders reach at most 8 days ahead');
  }
  // Only future reminders: past ones would jump the queue for everyone (review M1).
  const future = input.items.filter((i) => i.fire_at > now);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM reminders WHERE target_user_id = ? AND space_id = ? AND kind = 'reminder'",
    ).bind(uid, input.space_id),
    ...future.map((item) =>
      c.env.DB.prepare(
        `INSERT INTO reminders (id, space_id, target_user_id, sender_user_id, kind, scope, fire_at, key_version, payload, created_at)
         VALUES (?, ?, ?, ?, 'reminder', 'user', ?, ?, ?, ?)`,
      ).bind(
        newId(),
        input.space_id,
        uid,
        uid,
        item.fire_at,
        item.key_version,
        pack(item.payload),
        now,
      ),
    ),
  ]);
  return c.json({ ok: true, stored: future.length });
});
