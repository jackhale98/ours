// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Encrypted key backups (wrapped with the recovery phrase on device).
 *
 * Writes are compare-and-swap on the version (review finding M3): a device
 * must send exactly the next version, so a device restored from an older
 * backup cannot silently overwrite a newer one; it gets 409 and must merge.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, requireAuth } from '../auth/session';
import { bytesOf, fromB64Url, toB64Url } from '../lib/crypto';
import { body, HttpError } from '../lib/http';

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
