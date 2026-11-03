// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Opt-in busy-time calendar feed (phase 6).
 *
 * The server cannot read plans, so a calendar app subscribing to Ours can
 * only be given what the user's device chooses to publish: start and end of
 * busy blocks, in plaintext (THREAT_MODEL: feed_busy). The device recomputes
 * and replaces them as plans change. The feed URL holds a 256-bit token
 * stored only as a hash; "new link" revokes the old one; turning the feed
 * off deletes the blocks.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, requireAuth } from '../auth/session';
import { hashToken, newToken } from '../lib/crypto';
import { body, HttpError } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';

export const MAX_FEED_BLOCKS = 500;
const DAY = 86_400_000;
const PAST_MS = 7 * DAY;
const AHEAD_MS = 62 * DAY;
const MAX_BLOCK_MS = 14 * DAY;
const TOKEN = /^([A-Za-z0-9_-]{43})\.ics$/;

export const feed = new Hono<AppEnv>();

/* ---------- the user's own controls ---------- */

feed.get('/status', requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT created_at FROM feed_tokens WHERE user_id = ? AND revoked_at IS NULL',
  )
    .bind(c.var.user.id)
    .first<{ created_at: number }>();
  return c.json({ on: !!row, since: row?.created_at ?? null });
});

/** Turns the feed on, or replaces its link (the old one stops working). */
feed.post('/', requireAuth, async (c) => {
  const uid = c.var.user.id;
  await rateLimit(c.env, `feed-new:${uid}`, 20, 86_400);
  const token = newToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE feed_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).bind(now, uid),
    c.env.DB.prepare(
      'INSERT INTO feed_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)',
    ).bind(await hashToken(token), uid, now),
  ]);
  const url = `${new URL(c.req.url).origin}/feed/${token}.ics`;
  return c.json({ url }, 201);
});

/** Turns the feed off: revokes the link and deletes the published busy times. */
feed.delete('/', requireAuth, async (c) => {
  const uid = c.var.user.id;
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE feed_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).bind(Date.now(), uid),
    c.env.DB.prepare('DELETE FROM feed_busy WHERE user_id = ?').bind(uid),
  ]);
  return c.json({ ok: true });
});

/** Replaces the busy blocks the feed publishes. Only while the feed is on. */
feed.put('/busy', requireAuth, async (c) => {
  const uid = c.var.user.id;
  const Ms = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2 ** 48));
  const input = await body(
    c,
    v.strictObject({
      blocks: v.pipe(v.array(v.strictObject({ start: Ms, end: Ms })), v.maxLength(MAX_FEED_BLOCKS)),
    }),
  );
  await rateLimit(c.env, `feed-busy:${uid}`, 240, 3600);
  const on = await c.env.DB.prepare(
    'SELECT 1 FROM feed_tokens WHERE user_id = ? AND revoked_at IS NULL',
  )
    .bind(uid)
    .first();
  if (!on) throw new HttpError(409, 'feed_off', 'Turn the calendar feed on first.');
  const now = Date.now();
  for (const b of input.blocks) {
    if (b.end <= b.start || b.end - b.start > MAX_BLOCK_MS)
      throw new HttpError(422, 'invalid', 'Bad busy block');
  }
  const kept = input.blocks.filter((b) => b.end > now - PAST_MS && b.start < now + AHEAD_MS);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM feed_busy WHERE user_id = ?').bind(uid),
    ...kept.map((b) =>
      c.env.DB.prepare('INSERT INTO feed_busy (user_id, start_utc, end_utc) VALUES (?, ?, ?)').bind(
        uid,
        b.start,
        b.end,
      ),
    ),
  ]);
  return c.json({ ok: true, stored: kept.length });
});

/* ---------- the feed itself (no sign-in: the link is the credential) ---------- */

const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

async function blockUid(userId: string, start: number, end: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${userId}|${start}|${end}`),
  );
  return `${[...new Uint8Array(digest).subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')}@ours`;
}

feed.get('/:file', async (c) => {
  const m = TOKEN.exec(c.req.param('file'));
  if (!m?.[1]) throw new HttpError(404, 'not_found');
  const tokenHash = await hashToken(m[1]);
  await rateLimit(c.env, `feed-get:${tokenHash}`, 120, 3600);
  const row = await c.env.DB.prepare(
    'SELECT user_id FROM feed_tokens WHERE token_hash = ? AND revoked_at IS NULL',
  )
    .bind(tokenHash)
    .first<{ user_id: string }>();
  if (!row) throw new HttpError(404, 'not_found');
  const now = Date.now();
  const blocks = await c.env.DB.prepare(
    `SELECT start_utc, end_utc FROM feed_busy
      WHERE user_id = ? AND end_utc > ? AND start_utc < ?
      ORDER BY start_utc LIMIT ?`,
  )
    .bind(row.user_id, now - PAST_MS, now + AHEAD_MS, MAX_FEED_BLOCKS)
    .all<{ start_utc: number; end_utc: number }>();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ours//Busy feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Ours (busy)',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const b of blocks.results) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${await blockUid(row.user_id, b.start_utc, b.end_utc)}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(b.start_utc)}`,
      `DTEND:${stamp(b.end_utc)}`,
      'SUMMARY:Busy',
      'TRANSP:OPAQUE',
      'CLASS:PRIVATE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR', '');
  return new Response(lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=900',
      'Content-Disposition': 'inline; filename="ours-busy.ics"',
    },
  });
});
