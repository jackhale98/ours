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
import type { Env } from '../env';
import { bytesOf, fromB64Url, toB64Url } from '../lib/crypto';
import { type Email, sendEmail } from '../lib/email';
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

/* ---------- passkey unlock (ADR 0015, review 0006) ---------- */

const PasskeyId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{16,1366}$/));
const MAX_UNLOCK = 256 * 1024;
/** Setting a copy needs that passkey to have signed in or confirmed this recently (L2). */
const CONFIRMED_MS = 10 * 60_000;
const Version = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000));

const passkeyId = (raw: string) => {
  const r = v.safeParse(PasskeyId, raw);
  if (!r.success) throw new HttpError(404, 'not_found');
  return r.output;
};

/** The switch covers every use, not only setting it up (L1). */
const requireOn = (env: { PASSKEY_UNLOCK?: string }) => {
  if (env.PASSKEY_UNLOCK !== 'on')
    throw new HttpError(403, 'unlock_off', 'Unlocking with a passkey isn’t available.');
};

/** At most one notice of a kind an hour, so they can't be used to flood someone (L3). */
async function notice(env: Env, kind: string, uid: string, email: Email): Promise<void> {
  try {
    await rateLimit(env, `unlock-mail:${kind}:${uid}`, 1, 3600);
  } catch {
    return;
  }
  await sendEmail(env, email).catch(() => {});
}

/** Which of my passkeys can unlock my keys, and which key versions each copy holds. */
keys.get('/unlocks', async (c) => {
  requireOn(c.env);
  const rows = await c.env.DB.prepare(
    `SELECT passkey_id, created_at, space_version, personal_version
       FROM key_unlocks WHERE user_id = ? ORDER BY created_at`,
  )
    .bind(c.var.user.id)
    .all<{
      passkey_id: string;
      created_at: number;
      space_version: number;
      personal_version: number;
    }>();
  return c.json({ unlocks: rows.results });
});

/**
 * Stores (or replaces) the copy sealed for one of my passkeys. Only from a
 * session that signed in or confirmed with that very passkey in the last
 * minutes (L2), and only for a passkey added after my latest change of keys,
 * so a lost phone's passkey can't be used to undo a rotation (M1).
 */
keys.put('/unlock/:id', async (c) => {
  requireOn(c.env);
  const uid = c.var.user.id;
  const id = passkeyId(c.req.param('id'));
  const input = await body(
    c,
    v.strictObject({
      space_version: Version,
      personal_version: Version,
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
  await rateLimit(c.env, `unlock-set:${uid}`, 20, 3600);
  const s = c.var.session;
  if (s.passkey_id !== id || Date.now() - Math.max(s.created_at, s.reauth_at ?? 0) > CONFIRMED_MS)
    throw new HttpError(403, 'reauth_required', 'Confirm with that passkey first.');
  const pk = await c.env.DB.prepare(
    `SELECT p.created_at > COALESCE(u.keys_changed_at, 0) AS ok
       FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.user_id = ?`,
  )
    .bind(id, uid)
    .first<{ ok: number }>();
  if (!pk) throw new HttpError(404, 'not_found', 'That passkey isn’t on this account.');
  if (!pk.ok)
    throw new HttpError(
      409,
      'passkey_too_old',
      'This passkey was added before you changed your keys, so it can’t unlock them. Add a new one.',
    );
  // A device still on an older personal key can't replace a copy of a newer
  // one (I8). Only the personal version is compared: it only ever goes up,
  // while space versions start again in a new space (F2).
  const existing = await c.env.DB.prepare(
    'SELECT personal_version FROM key_unlocks WHERE passkey_id = ? AND user_id = ?',
  )
    .bind(id, uid)
    .first<{ personal_version: number }>();
  if (existing && input.personal_version < existing.personal_version)
    throw new HttpError(
      409,
      'newer_copy',
      'This passkey already unlocks newer keys. If that’s wrong, choose “Stop unlocking” for it, then turn it on again.',
    );
  const nonce = fromB64Url(input.wrapped.nonce);
  const ct = fromB64Url(input.wrapped.ciphertext);
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce);
  packed.set(ct, nonce.length);
  await c.env.DB.prepare(
    `INSERT INTO key_unlocks (passkey_id, user_id, wrapped, created_at, space_version, personal_version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(passkey_id) DO UPDATE SET wrapped = excluded.wrapped, created_at = excluded.created_at,
       space_version = excluded.space_version, personal_version = excluded.personal_version
       WHERE key_unlocks.user_id = ?2`,
  )
    .bind(id, uid, packed, Date.now(), input.space_version, input.personal_version)
    .run();
  c.executionCtx.waitUntil(
    notice(c.env, 'set', uid, {
      to: c.var.user.email,
      subject: 'Passkey unlock is on for your Ours account',
      text: 'One of your passkeys can now unlock your Ours keys on a new device, after face, fingerprint or device passcode. If this wasn’t you, open Ours → Privacy, remove the passkey, and change your keys.',
    }),
  );
  return c.json({ ok: true });
});

/** The sealed copy for one of my passkeys: fetched to unlock a new device. */
keys.get('/unlock/:id', async (c) => {
  requireOn(c.env);
  const uid = c.var.user.id;
  const id = passkeyId(c.req.param('id'));
  await rateLimit(c.env, `unlock-get:${uid}`, 10, 3600);
  const row = await c.env.DB.prepare(
    'SELECT wrapped FROM key_unlocks WHERE passkey_id = ? AND user_id = ?',
  )
    .bind(id, uid)
    .first<{ wrapped: ArrayBuffer }>();
  if (!row) throw new HttpError(404, 'not_found');
  // So an unlock someone else tried doesn't go unnoticed. The server can't
  // tell whether it opened, so it says what it knows (L3).
  // Every fetch is told (fetches are limited to 10 an hour anyway), so a
  // second device asking in the same hour isn't hidden (review 0006, N4).
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: c.var.user.email,
      subject: 'A device asked to unlock your Ours keys with a passkey',
      text: 'A device just fetched the copy of your Ours keys that one of your passkeys can open. If this wasn’t you, open Ours → Privacy, remove that passkey and devices you don’t recognise, and change your keys.',
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

/** Turning it off always works, even with the switch off. */
keys.delete('/unlock/:id', async (c) => {
  const uid = c.var.user.id;
  const id = passkeyId(c.req.param('id'));
  const res = await c.env.DB.prepare('DELETE FROM key_unlocks WHERE passkey_id = ? AND user_id = ?')
    .bind(id, uid)
    .run();
  // Every time: only a stored copy can be turned off, so this can't be used to flood (F4).
  if (res.meta.changes)
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: c.var.user.email,
        subject: 'A passkey no longer unlocks your Ours keys',
        text: 'Unlocking with one of your passkeys was just turned off. If this wasn’t you, sign in, check Privacy → Passkeys, and change your keys.',
      }).catch(() => {}),
    );
  return c.json({ ok: true });
});
