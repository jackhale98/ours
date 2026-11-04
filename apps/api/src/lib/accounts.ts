// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account deletion (used by DELETE /me and the inactive-account job) and the
 * inactive-account policy: a warning email after 12 months without
 * activity, deletion a month later. Both periods are configurable and
 * disclosed in the privacy policy.
 */
import type { Env } from '../env';
import { num } from '../env';
import { sendEmail } from './email';
import { SPACE_BYTES_SQL } from './quota';

const DAY = 86_400_000;

/**
 * Deletes the account and everything only this user can read. Shared records
 * stay with the partner; a space with no members left is deleted entirely.
 */
export async function deleteAccount(env: Env, uid: string, email: string): Promise<void> {
  const spaces = await env.DB.prepare('SELECT space_id FROM memberships WHERE user_id = ?')
    .bind(uid)
    .all<{ space_id: string }>();
  const statements = [
    env.DB.prepare('DELETE FROM records WHERE owner_user_id = ?').bind(uid),
    // No trace of the id left behind on shared records or claimed invites.
    env.DB.prepare("UPDATE records SET updated_by = 'deleted' WHERE updated_by = ?").bind(uid),
    env.DB.prepare('UPDATE invites SET claimed_by = NULL WHERE claimed_by = ?').bind(uid),
    env.DB.prepare('DELETE FROM email_tokens WHERE email = ?').bind(email),
    // Cascades sessions, devices, passkeys, memberships, backups, push, feed, reminders.
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid),
    env.DB.prepare("DELETE FROM key_ids WHERE scope = 'user' AND owner = ?").bind(uid),
    env.DB.prepare('UPDATE spaces SET rotated_by = NULL WHERE rotated_by = ?').bind(uid),
  ];
  for (const { space_id } of spaces.results) {
    statements.push(
      env.DB.prepare(
        'DELETE FROM spaces WHERE id = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE space_id = ?)',
      ).bind(space_id, space_id),
      env.DB.prepare(`UPDATE spaces SET bytes = ${SPACE_BYTES_SQL} WHERE id = ?`).bind(
        space_id,
        space_id,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "DELETE FROM key_ids WHERE scope = 'space' AND owner NOT IN (SELECT id FROM spaces)",
    ),
  );
  await env.DB.batch(statements);
}

/** Per run, so a large backlog spreads over several days within Workers limits. */
const BATCH = 25;

/**
 * Daily: warns accounts inactive for INACTIVE_WARN_DAYS (default 365) and
 * deletes those still inactive INACTIVE_GRACE_DAYS (default 30) after the
 * warning. Signing in at any point clears the warning.
 */
export async function inactiveAccounts(
  env: Env,
  now = Date.now(),
): Promise<{ warned: number; deleted: number }> {
  const warnAfter = num(env.INACTIVE_WARN_DAYS, 365) * DAY;
  const grace = num(env.INACTIVE_GRACE_DAYS, 30) * DAY;
  // Came back after a warning: forget it.
  await env.DB.prepare(
    'UPDATE users SET inactive_warned_at = NULL WHERE inactive_warned_at IS NOT NULL AND last_active > inactive_warned_at',
  ).run();

  const toWarn = await env.DB.prepare(
    `SELECT id, email FROM users
      WHERE inactive_warned_at IS NULL AND COALESCE(last_active, created_at) < ?
      LIMIT ?`,
  )
    .bind(now - warnAfter, BATCH)
    .all<{ id: string; email: string }>();
  const app = env.APP_URL ?? '';
  for (const u of toWarn.results) {
    await sendEmail(env, {
      to: u.email,
      subject: 'Your Ours account will be deleted in 30 days',
      text: [
        'You haven’t used Ours for a year, so we’ll delete your account and everything only you can read in 30 days.',
        '',
        `To keep it, just open Ours and sign in: ${app}`,
        '',
        'Plans you shared stay with your partner. If you want a copy first, sign in and use Export in Privacy.',
        '',
        'You don’t need to do anything if you’re happy for it to go.',
      ].join('\n'),
    }).catch(() => undefined);
    await env.DB.prepare('UPDATE users SET inactive_warned_at = ? WHERE id = ?')
      .bind(now, u.id)
      .run();
  }

  const toDelete = await env.DB.prepare(
    `SELECT id, email FROM users
      WHERE inactive_warned_at IS NOT NULL AND inactive_warned_at < ?
        AND COALESCE(last_active, created_at) < ?
      LIMIT ?`,
  )
    .bind(now - grace, now - warnAfter, BATCH)
    .all<{ id: string; email: string }>();
  for (const u of toDelete.results) await deleteAccount(env, u.id, u.email);
  return { warned: toWarn.results.length, deleted: toDelete.results.length };
}
