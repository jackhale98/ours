// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Encrypted record sync (docs/adr/0004-sync-approach.md).
 *
 * Push: each envelope carries the rev it was based on. In one D1 batch
 * (a transaction) the space's sequence is advanced and every accepted record
 * is written with a new rev, conditional on its stored rev still matching.
 * Records that lost a race come back as conflicts with the current envelope.
 *
 * Scope enforcement is in the SQL, not just the route logic:
 * - every query is filtered by space membership;
 * - user-scope records are written only with owner_user_id = caller and are
 *   returned only to their owner;
 * - an existing record can only be overwritten in the same space, scope and
 *   owner (the upsert's WHERE clause).
 */
import { type Envelope, MAX_CIPHERTEXT_BYTES } from '@ours/core/schema';
import { PullQuery, PushRequest, type PushResult } from '@ours/core/sync';
import { Hono } from 'hono';
import { type AppEnv, requireAuth } from '../auth/session';
import { num } from '../env';
import { bytesOf, fromB64Url, toB64Url } from '../lib/crypto';
import { body, query } from '../lib/http';
import { requireMember } from '../lib/members';
import { rateLimit } from '../lib/ratelimit';

interface Row {
  id: string;
  space_id: string;
  scope: 'space' | 'user';
  owner_user_id: string | null;
  key_version: number;
  nonce: ArrayBuffer;
  ciphertext: ArrayBuffer;
  deleted: number;
  rev: number;
  updated_at: number;
  updated_by: string;
}

const COLUMNS =
  'id, space_id, scope, owner_user_id, key_version, nonce, ciphertext, deleted, rev, updated_at, updated_by';

export function toEnvelope(r: Row): Envelope {
  return {
    id: r.id,
    space_id: r.space_id,
    scope: r.scope,
    owner_user_id: r.owner_user_id,
    key_version: r.key_version,
    nonce: toB64Url(bytesOf(r.nonce)),
    ciphertext: toB64Url(bytesOf(r.ciphertext)),
    deleted: r.deleted === 1,
    rev: r.rev,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export const sync = new Hono<AppEnv>();
sync.use('*', requireAuth);

sync.post('/push', async (c) => {
  const uid = c.var.user.id;
  const req = await body(c, PushRequest);
  await requireMember(c.env, req.space_id, uid);
  await rateLimit(c.env, `push:${uid}`, num(c.env.MAX_PUSHES_PER_MINUTE, 120), 60);

  const ids = req.items.map((i) => i.envelope.id);
  const existing = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM records WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .all<Row>();
  const byId = new Map(existing.results.map((r) => [r.id, r]));

  const results = new Map<string, PushResult>();
  const accepted: {
    item: (typeof req.items)[number];
    nonce: Uint8Array;
    ct: Uint8Array;
    oldBytes: number;
  }[] = [];

  for (const item of req.items) {
    const e = item.envelope;
    if (e.scope === 'user' && e.owner_user_id !== uid) {
      results.set(e.id, { status: 'rejected', id: e.id, reason: 'not_owner' });
      continue;
    }
    const nonce = fromB64Url(e.nonce);
    const ct = fromB64Url(e.ciphertext);
    if (ct.length > MAX_CIPHERTEXT_BYTES) {
      results.set(e.id, { status: 'rejected', id: e.id, reason: 'too_large' });
      continue;
    }
    const cur = byId.get(e.id);
    if (cur) {
      // Never reveal or touch a record the caller can't see: other space,
      // another user's private record, or a different scope/owner.
      const visible =
        cur.space_id === req.space_id && (cur.scope === 'space' || cur.owner_user_id === uid);
      if (!visible || cur.scope !== e.scope || cur.owner_user_id !== e.owner_user_id) {
        results.set(e.id, { status: 'rejected', id: e.id, reason: 'not_allowed' });
        continue;
      }
      // Idempotent retry of a write that already landed.
      if (
        sameBytes(bytesOf(cur.nonce), nonce) &&
        sameBytes(bytesOf(cur.ciphertext), ct) &&
        (cur.deleted === 1) === e.deleted
      ) {
        results.set(e.id, { status: 'ok', id: e.id, rev: cur.rev });
        continue;
      }
      if (cur.rev !== item.base_rev) {
        results.set(e.id, { status: 'conflict', id: e.id, current: toEnvelope(cur) });
        continue;
      }
    }
    accepted.push({ item, nonce, ct, oldBytes: cur ? bytesOf(cur.ciphertext).length : 0 });
  }

  let seq = 0;
  if (accepted.length) {
    const space = await c.env.DB.prepare('SELECT bytes FROM spaces WHERE id = ?')
      .bind(req.space_id)
      .first<{ bytes: number }>();
    const delta = accepted.reduce((n, a) => n + a.ct.length - a.oldBytes, 0);
    if ((space?.bytes ?? 0) + delta > num(c.env.MAX_SPACE_BYTES, 20 * 1024 * 1024)) {
      for (const a of accepted)
        results.set(a.item.envelope.id, {
          status: 'rejected',
          id: a.item.envelope.id,
          reason: 'quota',
        });
      accepted.length = 0;
    } else {
      const now = Date.now();
      const n = accepted.length;
      const statements = [
        c.env.DB.prepare('UPDATE spaces SET seq = seq + ?, bytes = bytes + ? WHERE id = ?').bind(
          n,
          delta,
          req.space_id,
        ),
        ...accepted.map((a, k) => {
          const e = a.item.envelope;
          return c.env.DB.prepare(
            `INSERT INTO records (${COLUMNS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT seq FROM spaces WHERE id = ?2) - ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               key_version = excluded.key_version, nonce = excluded.nonce, ciphertext = excluded.ciphertext,
               deleted = excluded.deleted, rev = excluded.rev, updated_at = excluded.updated_at,
               updated_by = excluded.updated_by
             WHERE records.rev = ?12 AND records.space_id = excluded.space_id
               AND records.scope = excluded.scope AND records.owner_user_id IS excluded.owner_user_id`,
          ).bind(
            e.id,
            req.space_id,
            e.scope,
            e.owner_user_id,
            e.key_version,
            a.nonce,
            a.ct,
            e.deleted ? 1 : 0,
            n - 1 - k,
            now,
            uid,
            a.item.base_rev,
          );
        }),
        c.env.DB.prepare('SELECT seq FROM spaces WHERE id = ?').bind(req.space_id),
      ];
      const out = await c.env.DB.batch(statements);
      seq = (out[out.length - 1]?.results[0] as { seq: number } | undefined)?.seq ?? 0;
      const lost: string[] = [];
      accepted.forEach((a, k) => {
        const id = a.item.envelope.id;
        if (out[k + 1]?.meta.changes) results.set(id, { status: 'ok', id, rev: seq - (n - 1 - k) });
        else lost.push(id);
      });
      if (lost.length) {
        // Lost a race with another device: report the current versions, and
        // recompute the space's byte count since our delta over-counted.
        const current = await c.env.DB.prepare(
          `SELECT ${COLUMNS} FROM records WHERE id IN (${lost.map(() => '?').join(',')})`,
        )
          .bind(...lost)
          .all<Row>();
        for (const r of current.results)
          results.set(r.id, { status: 'conflict', id: r.id, current: toEnvelope(r) });
        await c.env.DB.prepare(
          'UPDATE spaces SET bytes = (SELECT COALESCE(SUM(length(ciphertext)), 0) FROM records WHERE space_id = ?) WHERE id = ?',
        )
          .bind(req.space_id, req.space_id)
          .run();
      }
    }
  }
  if (!seq) {
    seq =
      (
        await c.env.DB.prepare('SELECT seq FROM spaces WHERE id = ?')
          .bind(req.space_id)
          .first<{ seq: number }>()
      )?.seq ?? 0;
  }
  return c.json({ results: req.items.map((i) => results.get(i.envelope.id)), seq });
});

sync.get('/pull', async (c) => {
  const uid = c.var.user.id;
  const q = query(c, PullQuery);
  await requireMember(c.env, q.space_id, uid);
  const rows = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM records
      WHERE space_id = ?1 AND rev > ?2 AND (scope = 'space' OR owner_user_id = ?3)
      ORDER BY rev LIMIT ?4`,
  )
    .bind(q.space_id, q.since, uid, q.limit + 1)
    .all<Row>();
  const more = rows.results.length > q.limit;
  const page = rows.results.slice(0, q.limit);
  return c.json({
    envelopes: page.map(toEnvelope),
    cursor: page.length ? (page[page.length - 1]?.rev ?? q.since) : q.since,
    more,
  });
});
