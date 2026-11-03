// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Relay for calendar subscription links (ADR 0011).
 *
 * Browsers can't fetch most calendar URLs directly (no CORS), so a signed-in
 * device asks the Worker to fetch one. The Worker sees the link and the
 * calendar in transit, stores neither and logs neither (route logs only).
 * The device parses the calendar and stores it encrypted.
 *
 * Guard rails: https only; no IP literals, local or internal names, or this
 * API's own host; redirects re-checked (at most 3); 10 s timeout; 5 MB cap;
 * the response must be an iCalendar file, so this is not a general proxy;
 * per-user rate limit.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, requireAuth } from '../auth/session';
import { body, HttpError } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';

export const MAX_CALENDAR_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** For the whole fetch, redirects included. */
const TIMEOUT_MS = 15_000;

/** Whether the Worker may fetch this URL (checked again after each redirect). */
export function isFetchableCalendarUrl(raw: string, ownHost: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.')) return false; // single-label names
  if (host === ownHost.toLowerCase()) return false;
  // IP literals (v4 and v6) are refused outright: calendar hosts have names.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[') || /^\d+$/.test(host)) return false;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa)$/.test(host)) return false;
  return true;
}

export const calendars = new Hono<AppEnv>();
calendars.use('*', requireAuth);

calendars.post('/fetch', async (c) => {
  const uid = c.var.user.id;
  const input = await body(c, v.strictObject({ url: v.pipe(v.string(), v.maxLength(2048)) }));
  await rateLimit(c.env, `cal-fetch:${uid}`, 60, 3600);
  const ownHost = new URL(c.req.url).hostname;
  let url = input.url;
  let res: Response | null = null;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isFetchableCalendarUrl(url, ownHost))
      throw new HttpError(
        422,
        'bad_url',
        'That link can’t be used. Check it starts with https://.',
      );
    try {
      res = await fetch(url, {
        redirect: 'manual',
        headers: {
          Accept: 'text/calendar, text/plain;q=0.5, */*;q=0.1',
          'User-Agent': 'Ours calendar relay (+https://github.com/jackhale98/ours)',
        },
        signal,
      });
    } catch {
      throw new HttpError(502, 'unreachable', 'Couldn’t reach that calendar. Try again later.');
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('Location');
      await res.body?.cancel();
      if (!next) break;
      try {
        url = new URL(next, url).href;
      } catch {
        throw new HttpError(502, 'upstream', 'That calendar link redirects somewhere invalid.');
      }
      res = null;
      continue;
    }
    break;
  }
  if (!res) throw new HttpError(502, 'too_many_redirects', 'That link redirects too many times.');
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(
      502,
      'upstream',
      res.status === 404 || res.status === 410
        ? 'That calendar link no longer works.'
        : 'The calendar server didn’t send the calendar. Try again later.',
    );
  }
  const declared = Number(res.headers.get('Content-Length') ?? 0);
  if (declared > MAX_CALENDAR_BYTES) {
    await res.body?.cancel();
    throw new HttpError(413, 'too_large', 'That calendar is too big to import.');
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CALENDAR_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'too_large', 'That calendar is too big to import.');
      }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const ch of chunks) {
    all.set(ch, at);
    at += ch.byteLength;
  }
  const text = new TextDecoder().decode(all);
  if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(text))
    throw new HttpError(422, 'not_a_calendar', 'That link isn’t a calendar (.ics) file.');
  return new Response(text, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' },
  });
});
