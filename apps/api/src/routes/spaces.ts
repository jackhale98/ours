// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, requireAuth } from '../auth/session';
import { num } from '../env';
import { newId } from '../lib/crypto';
import { sendEmail } from '../lib/email';
import { body, HttpError } from '../lib/http';
import { requireMember } from '../lib/members';
import { isQuotaAbort, SPACE_BYTES_SQL } from '../lib/quota';
import { rateLimit } from '../lib/ratelimit';

export const spaces = new Hono<AppEnv>();
spaces.use('*', requireAuth);

/** Creates a space with the caller as member 'a'. The cap is enforced atomically in SQL. */
spaces.post('/', async (c) => {
  const uid = c.var.user.id;
  const max = num(c.env.MAX_SPACES_PER_USER, 3);
  const id = newId();
  const now = Date.now();
  // The membership insert is conditional on the cap, and the guard row aborts
  // (rolls back) the whole batch, including the space, when over it.
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO quota_guard (x) SELECT NULL WHERE (SELECT COUNT(*) FROM memberships WHERE user_id = ?) >= ?',
      ).bind(uid, max),
      c.env.DB.prepare('INSERT INTO spaces (id, created_at, seq) VALUES (?, ?, 0)').bind(id, now),
      c.env.DB.prepare(
        "INSERT INTO memberships (space_id, user_id, role, joined_at) VALUES (?, ?, 'a', ?)",
      ).bind(id, uid, now),
    ]);
  } catch (err) {
    if (isQuotaAbort(err)) throw new HttpError(409, 'too_many_spaces');
    throw err;
  }
  return c.json({ id, role: 'a' }, 201);
});

/** A sign-in (or passkey check) this recent is needed to change keys (review 0005, M4). */
export const RECENT_AUTH_MS = 10 * 60_000;
/** The rotator can send key update links for this long after rotating (review 0005, M4). */
export const REKEY_WINDOW_MS = 14 * 86_400_000;

const Version = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000));
/** Key fingerprint: 16 bytes, base64url (core `keyId`). */
const Kid = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/));

/** Changing keys can be switched off server-side (until its review signs off). */
export const rotationOff = () =>
  new HttpError(403, 'rotation_off', 'Changing keys isn’t available yet.');

const conflict = () =>
  new HttpError(409, 'rotation_conflict', 'Keys changed on another device. Try again.');

/**
 * The rotation itself, as one batch that is all-or-nothing (review 0005, M1):
 * the guard aborts and rolls back everything if either version moved since
 * the caller checked, e.g. the partner rotated in between.
 */
export function rotateStatements(
  db: D1Database,
  r: {
    spaceId: string;
    userId: string;
    spaceFrom: number;
    personalFrom: number;
    spaceKid: string;
    personalKid: string;
    now: number;
  },
): D1PreparedStatement[] {
  const space = r.spaceFrom + 1;
  const personal = r.personalFrom + 1;
  return [
    db
      .prepare(
        `INSERT INTO quota_guard (x) SELECT NULL
          WHERE (SELECT key_version FROM spaces WHERE id = ?1) IS NOT ?2
             OR (SELECT personal_key_version FROM users WHERE id = ?3) IS NOT ?4`,
      )
      .bind(r.spaceId, r.spaceFrom, r.userId, r.personalFrom),
    db
      .prepare(
        'UPDATE spaces SET key_version = ?2, rotated_rev = seq, rotated_by = ?3, rotated_at = ?4 WHERE id = ?1',
      )
      .bind(r.spaceId, space, r.userId, r.now),
    db.prepare('UPDATE users SET personal_key_version = ?2 WHERE id = ?1').bind(r.userId, personal),
    db
      .prepare(
        `INSERT INTO key_ids (scope, owner, version, kid, created_at)
         VALUES ('space', ?1, ?2, ?3, ?7), ('user', ?4, ?5, ?6, ?7)`,
      )
      .bind(r.spaceId, space, r.spaceKid, r.userId, personal, r.personalKid, r.now),
    db
      .prepare('UPDATE memberships SET key_version = ?3 WHERE space_id = ?1 AND user_id = ?2')
      .bind(r.spaceId, r.userId, space),
    // Sealed under keys that are now old: my reminders (personal key) and
    // anything held for quiet hours in this space (space key) (L2).
    db
      .prepare(
        `DELETE FROM reminders WHERE space_id = ?1
           AND ((kind = 'reminder' AND target_user_id = ?2) OR kind = 'deferred')`,
      )
      .bind(r.spaceId, r.userId),
  ];
}

/**
 * Key rotation (ADR 0013): raises the minimum key versions for this space and
 * for the caller's personal records by exactly one, from the versions the
 * caller says it is rotating from, and records a fingerprint of each new key.
 * Old versions stay readable but can no longer be written; newer ones can't
 * be written until a rotation makes them current.
 *
 * Review 0005: the whole change is one all-or-nothing batch (M1); it needs a
 * recent sign-in when the account has a passkey to confirm with, and both
 * members are emailed (M4); reminders and held notifications sealed under
 * the old keys are dropped (L2); accounts in more than one space can't rotate,
 * since the personal key is shared by all of them (L4).
 */
spaces.post('/:id/rotate', async (c) => {
  const id = c.req.param('id');
  const uid = c.var.user.id;
  const input = await body(
    c,
    v.strictObject({
      space_from: Version,
      personal_from: Version,
      space_kid: Kid,
      personal_kid: Kid,
    }),
  );
  await requireMember(c.env, id, uid);
  if (c.env.ROTATION !== 'on') throw rotationOff();
  const info = await c.env.DB.prepare(
    `SELECT (SELECT key_version FROM spaces WHERE id = ?1) AS space,
            (SELECT personal_key_version FROM users WHERE id = ?2) AS personal,
            (SELECT COUNT(*) FROM memberships WHERE user_id = ?2) AS spaces,
            (SELECT COUNT(*) FROM passkeys WHERE user_id = ?2) AS passkeys`,
  )
    .bind(id, uid)
    .first<{ space: number; personal: number; spaces: number; passkeys: number }>();
  if ((info?.spaces ?? 0) > 1)
    throw new HttpError(409, 'multi_space', 'Leave your other spaces before changing keys.');
  const s = c.var.session;
  if (
    (info?.passkeys ?? 0) > 0 &&
    Date.now() - Math.max(s.created_at, s.reauth_at ?? 0) > RECENT_AUTH_MS
  )
    throw new HttpError(403, 'reauth_required', 'Confirm it’s you with your passkey first.');
  // A stale request is refused before it counts against the daily limit (I5).
  if (info?.space !== input.space_from || info?.personal !== input.personal_from) throw conflict();
  await rateLimit(c.env, `rotate:${uid}`, 10, 86_400);
  const space = input.space_from + 1;
  const personal = input.personal_from + 1;
  try {
    await c.env.DB.batch(
      rotateStatements(c.env.DB, {
        spaceId: id,
        userId: uid,
        spaceFrom: input.space_from,
        personalFrom: input.personal_from,
        spaceKid: input.space_kid,
        personalKid: input.personal_kid,
        now: Date.now(),
      }),
    );
  } catch (err) {
    if (isQuotaAbort(err)) throw conflict();
    throw err;
  }
  const after = await c.env.DB.prepare('SELECT rotated_rev FROM spaces WHERE id = ?')
    .bind(id)
    .first<{ rotated_rev: number }>();
  // Both people hear about it, so a rotation they didn't make doesn't go unnoticed.
  const emails = await c.env.DB.prepare(
    'SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.space_id = ?',
  )
    .bind(id)
    .all<{ email: string }>();
  c.executionCtx.waitUntil(
    Promise.all(
      emails.results.map((r) =>
        sendEmail(c.env, {
          to: r.email,
          subject: 'The keys for your Ours space were changed',
          text: 'Someone in your Ours space just made new encryption keys, which is usually done after losing a phone. If neither of you did this, open Ours → Privacy, remove devices you don’t recognise, and compare your safety codes in person before opening any key update link.',
        }).catch(() => {}),
      ),
    ),
  );
  return c.json({
    key_version: space,
    rotated_rev: after?.rotated_rev ?? 0,
    personal_key_version: personal,
  });
});

/**
 * How much is still sealed under old keys (review 0005, M2): live shared
 * records below the space version, and my live personal records below mine.
 */
spaces.get('/:id/rotation', async (c) => {
  const id = c.req.param('id');
  const uid = c.var.user.id;
  await requireMember(c.env, id, uid);
  const row = await c.env.DB.prepare(
    `SELECT s.key_version AS space, u.personal_key_version AS personal,
            (SELECT COUNT(*) FROM records r WHERE r.space_id = s.id AND r.scope = 'space'
               AND r.deleted = 0 AND r.key_version < s.key_version) AS space_below,
            (SELECT COUNT(*) FROM records r WHERE r.space_id = s.id AND r.scope = 'user'
               AND r.owner_user_id = u.id AND r.deleted = 0
               AND r.key_version < u.personal_key_version) AS mine_below
       FROM spaces s, users u WHERE s.id = ?1 AND u.id = ?2`,
  )
    .bind(id, uid)
    .first<{ space: number; personal: number; space_below: number; mine_below: number }>();
  return c.json({
    key_version: row?.space ?? 1,
    personal_key_version: row?.personal ?? 1,
    space_below: row?.space_below ?? 0,
    mine_below: row?.mine_below ?? 0,
  });
});

/** "I hold the current space key" (review 0005, M3): the rotator then stops offering a link. */
spaces.post('/:id/keys-ack', async (c) => {
  const id = c.req.param('id');
  const uid = c.var.user.id;
  const input = await body(c, v.strictObject({ key_version: Version, kid: Kid }));
  await requireMember(c.env, id, uid);
  const res = await c.env.DB.prepare(
    `UPDATE memberships SET key_version = ?3 WHERE space_id = ?1 AND user_id = ?2
        AND ?3 = (SELECT key_version FROM spaces WHERE id = ?1)
        AND EXISTS (SELECT 1 FROM key_ids WHERE scope = 'space' AND owner = ?1 AND version = ?3 AND kid = ?4)`,
  )
    .bind(id, uid, input.key_version, input.kid)
    .run();
  if (!res.meta.changes) throw new HttpError(409, 'not_current', 'Those aren’t the current keys.');
  return c.json({ ok: true });
});

/** Leaves a space. Removes the caller's private records in it; deletes the space if nobody is left. */
spaces.delete('/:id/membership', async (c) => {
  const id = c.req.param('id');
  const uid = c.var.user.id;
  await requireMember(c.env, id, uid);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM records WHERE space_id = ? AND owner_user_id = ?').bind(id, uid),
    c.env.DB.prepare('DELETE FROM memberships WHERE space_id = ? AND user_id = ?').bind(id, uid),
    // Their calendar feed published this space's busy times: turn it off (review 0004, L3).
    c.env.DB.prepare('DELETE FROM feed_busy WHERE user_id = ?').bind(uid),
    c.env.DB.prepare(
      'UPDATE feed_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).bind(Date.now(), uid),
    // Their reminders, and notifications they sent that are held for quiet hours.
    c.env.DB.prepare(
      'DELETE FROM reminders WHERE space_id = ? AND (target_user_id = ? OR sender_user_id = ?)',
    ).bind(id, uid, uid),
    c.env.DB.prepare(
      'DELETE FROM spaces WHERE id = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE space_id = ?)',
    ).bind(id, id),
    c.env.DB.prepare(
      "DELETE FROM key_ids WHERE scope = 'space' AND owner = ? AND NOT EXISTS (SELECT 1 FROM spaces WHERE id = ?)",
    ).bind(id, id),
    // Only the person who rotated may send key update links; that's no longer them.
    c.env.DB.prepare('UPDATE spaces SET rotated_by = NULL WHERE id = ? AND rotated_by = ?').bind(
      id,
      uid,
    ),
    c.env.DB.prepare(`UPDATE spaces SET bytes = ${SPACE_BYTES_SQL} WHERE id = ?`).bind(id, id),
  ]);
  return c.json({ ok: true });
});
