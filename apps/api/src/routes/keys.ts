// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Encrypted key backups (wrapped with the recovery phrase on device), and
 * passkey unlock copies (wrapped with a key from a passkey, ADR 0015).
 *
 * Writes are compare-and-swap on the version (review finding M3): a device
 * must send exactly the next version, so a device restored from an older
 * backup cannot silently overwrite a newer one; it gets 409 and must merge.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, requireAuth } from '../auth/session';
import { bytesOf, fromB64Url, toB64Url } from '../lib/crypto';
import { sendEmail } from '../lib/email';
import { body, HttpError } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';

const MAX_BACKUP = 256 * 1024;
const NONCE_BYTES = 24;

export const keys = new Hono<AppEnv>();
keys.use('*', requireAuth);

keys.get('/backup', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT wrapped, version, updated_at FROM key_backups WHERE user_id = ?',
  )
    .bind(c.var.user.id)
    .first<{ wrapped: ArrayBuffer; version: number; updated_at: number }>();
  if (!row) throw new HttpError(404, 'not_found');
  const bytes = bytesOf(row.wrapped);
  return c.json({
    version: row.version,
    updated_at: row.updated_at,
    wrapped: {
      nonce: toB64Url(bytes.subarray(0, NONCE_BYTES)),
      ciphertext: toB64Url(bytes.subarray(NONCE_BYTES)),
    },
  });
});

keys.put('/backup', async (c) => {
  const input = await body(
    c,
    v.strictObject({
      version: v.pipe(v.number(), v.integer(), v.minValue(1)),
      wrapped: v.strictObject({
        nonce: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{32}$/)),
        ciphertext: v.pipe(
          v.string(),
          v.regex(/^[A-Za-z0-9_-]+$/),
          v.maxLength(Math.ceil((MAX_BACKUP * 4) / 3)),
        ),
      }),
    }),
  );
  const nonce = fromB64Url(input.wrapped.nonce);
  const ct = fromB64Url(input.wrapped.ciphertext);
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce);
  packed.set(ct, nonce.length);
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `INSERT INTO key_backups (user_id, wrapped, version, updated_at)
       SELECT ?1, ?2, ?3, ?4 WHERE ?3 = 1 AND NOT EXISTS (SELECT 1 FROM key_backups WHERE user_id = ?1)
     ON CONFLICT(user_id) DO NOTHING`,
  )
    .bind(c.var.user.id, packed, input.version, now)
    .run();
  if (!result.meta.changes) {
    const updated = await c.env.DB.prepare(
      'UPDATE key_backups SET wrapped = ?2, version = ?3, updated_at = ?4 WHERE user_id = ?1 AND version = ?3 - 1',
    )
      .bind(c.var.user.id, packed, input.version, now)
      .run();
    if (!updated.meta.changes) {
      const current = await c.env.DB.prepare('SELECT version FROM key_backups WHERE user_id = ?')
        .bind(c.var.user.id)
        .first<{ version: number }>();
      return c.json({ error: 'version_conflict', current_version: current?.version ?? 0 }, 409);
    }
  }
  return c.json({ ok: true, version: input.version });
});

/* ---------- passkey unlock (ADR 0015) ---------- */

const PasskeyId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{16,1366}$/));
const MAX_UNLOCK = 256 * 1024;

const passkeyId = (raw: string) => {
  const r = v.safeParse(PasskeyId, raw);
  if (!r.success) throw new HttpError(404, 'not_found');
  return r.output;
};

/** Which of my passkeys can unlock my keys. */
keys.get('/unlocks', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT passkey_id, created_at FROM key_unlocks WHERE user_id = ? ORDER BY created_at',
  )
    .bind(c.var.user.id)
    .all<{ passkey_id: string; created_at: number }>();
  return c.json({ unlocks: rows.results });
});

/** Stores (or replaces) the copy sealed for one of my passkeys. */
keys.put('/unlock/:id', async (c) => {
  const uid = c.var.user.id;
  const id = passkeyId(c.req.param('id'));
  const input = await body(
    c,
    v.strictObject({
      wrapped: v.strictObject({
        nonce: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{32}$/)),
        ciphertext: v.pipe(
          v.string(),
          v.regex(/^[A-Za-z0-9_-]+$/),
          v.maxLength(Math.ceil((MAX_UNLOCK * 4) / 3)),
        ),
      }),
    }),
  );
  if (c.env.PASSKEY_UNLOCK !== 'on')
    throw new HttpError(403, 'unlock_off', 'Unlocking with a passkey isn’t available yet.');
  await rateLimit(c.env, `unlock-set:${uid}`, 20, 3600);
  const nonce = fromB64Url(input.wrapped.nonce);
  const ct = fromB64Url(input.wrapped.ciphertext);
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce);
  packed.set(ct, nonce.length);
  const res = await c.env.DB.prepare(
    `INSERT INTO key_unlocks (passkey_id, user_id, wrapped, created_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM passkeys WHERE id = ?1 AND user_id = ?2)
     ON CONFLICT(passkey_id) DO UPDATE SET wrapped = excluded.wrapped, created_at = excluded.created_at
       WHERE key_unlocks.user_id = ?2`,
  )
    .bind(id, uid, packed, Date.now())
    .run();
  if (!res.meta.changes)
    throw new HttpError(404, 'not_found', 'That passkey isn’t on this account.');
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: c.var.user.email,
      subject: 'Passkey unlock is on for your Ours account',
      text: 'One of your passkeys can now unlock your Ours keys on a new device, after face, fingerprint or device passcode. If this wasn’t you, open Ours → Privacy, remove the passkey, and change your keys.',
    }).catch(() => {}),
  );
  return c.json({ ok: true });
});

/** The sealed copy for one of my passkeys: fetched to unlock a new device. */
keys.get('/unlock/:id', async (c) => {
  const uid = c.var.user.id;
  const id = passkeyId(c.req.param('id'));
  await rateLimit(c.env, `unlock-get:${uid}`, 10, 3600);
  const row = await c.env.DB.prepare(
    'SELECT wrapped FROM key_unlocks WHERE passkey_id = ? AND user_id = ?',
  )
    .bind(id, uid)
    .first<{ wrapped: ArrayBuffer }>();
  if (!row) throw new HttpError(404, 'not_found');
  // So an unlock someone else made doesn't go unnoticed.
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: c.var.user.email,
      subject: 'Your Ours keys were unlocked with a passkey',
      text: 'A device just used one of your passkeys to unlock your Ours keys. If this wasn’t you, open Ours → Privacy, remove that passkey and devices you don’t recognise, and change your keys.',
    }).catch(() => {}),
  );
  const bytes = bytesOf(row.wrapped);
  return c.json({
    wrapped: {
      nonce: toB64Url(bytes.subarray(0, NONCE_BYTES)),
      ciphertext: toB64Url(bytes.subarray(NONCE_BYTES)),
    },
  });
});

keys.delete('/unlock/:id', async (c) => {
  const id = passkeyId(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM key_unlocks WHERE passkey_id = ? AND user_id = ?')
    .bind(id, c.var.user.id)
    .run();
  return c.json({ ok: true });
});
