// SPDX-License-Identifier: AGPL-3.0-or-later

import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFetchableCalendarUrl } from '../src/routes/calendars';
import { call, couple, signIn, uniqueEmail } from './helpers';

afterEach(() => vi.unstubAllGlobals());

async function getFeed(url: string) {
  const path = new URL(url).pathname;
  const res = await exports.default.fetch(
    new Request(`https://api.example${path}`, { headers: { 'CF-Connecting-IP': '198.51.100.7' } }),
  );
  return {
    status: res.status,
    text: await res.text(),
    type: res.headers.get('Content-Type'),
    cache: res.headers.get('Cache-Control'),
  };
}

describe('calendar feed', () => {
  it('publishes only busy times, behind a link that can be replaced or turned off', async () => {
    const u = await signIn(uniqueEmail());
    const now = Date.now();
    const blocks = [
      { start: now + 3_600_000, end: now + 7_200_000 },
      { start: now + 86_400_000, end: now + 90_000_000 },
    ];
    // Off by default: nothing can be published.
    expect((await call('/feed/status', { token: u.token })).json.on).toBe(false);
    const early = await call('/feed/busy', { token: u.token, method: 'PUT', body: { blocks } });
    expect(early.status).toBe(409);

    const on = await call('/feed', { token: u.token, body: {} });
    expect(on.status).toBe(201);
    const url = on.json.url as string;
    expect(url).toMatch(/\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
    const put = await call('/feed/busy', { token: u.token, method: 'PUT', body: { blocks } });
    expect(put.json.stored).toBe(2);

    const ics = await getFeed(url);
    expect(ics.status).toBe(200);
    expect(ics.type).toContain('text/calendar');
    expect(ics.text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.text).toContain('SUMMARY:Busy');
    expect(ics.text.split('\r\n').at(0)).toBe('BEGIN:VCALENDAR');

    // A new link revokes the old one.
    const again = await call('/feed', { token: u.token, body: {} });
    expect((await getFeed(url)).status).toBe(404);
    expect((await getFeed(again.json.url)).status).toBe(200);

    // Off: the link dies and the busy times are deleted.
    await call('/feed', { token: u.token, method: 'DELETE' });
    expect((await getFeed(again.json.url)).status).toBe(404);
    expect((await call('/feed/status', { token: u.token })).json.on).toBe(false);
  });

  it('rejects bad blocks and unknown links', async () => {
    const u = await signIn(uniqueEmail());
    await call('/feed', { token: u.token, body: {} });
    const now = Date.now();
    const backwards = await call('/feed/busy', {
      token: u.token,
      method: 'PUT',
      body: { blocks: [{ start: now + 2, end: now + 1 }] },
    });
    expect(backwards.status).toBe(422);
    const tooMany = await call('/feed/busy', {
      token: u.token,
      method: 'PUT',
      body: {
        blocks: Array.from({ length: 501 }, (_, i) => ({ start: now + i, end: now + i + 1 })),
      },
    });
    expect(tooMany.status).toBe(422);
    expect((await getFeed(`https://x/feed/${'A'.repeat(43)}.ics`)).status).toBe(404);
    expect((await getFeed('https://x/feed/short.ics')).status).toBe(404);
  });
});

describe('calendar feed review fixes (0004)', () => {
  it('keeps its own caching header (Info)', async () => {
    const u = await signIn(uniqueEmail());
    const on = await call('/feed', { token: u.token, body: {} });
    expect((await getFeed(on.json.url)).cache).toBe('private, max-age=900');
  });

  it('random links do not add rate-limit rows per guess (L2)', async () => {
    const rows = async () =>
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits').first<{ n: number }>())?.n ??
      0;
    const before = await rows();
    for (let i = 0; i < 20; i++) {
      const token = `${'A'.repeat(40)}${String(i).padStart(3, '0')}`;
      expect((await getFeed(`https://x/feed/${token}.ics`)).status).toBe(404);
    }
    expect((await rows()) - before).toBeLessThanOrEqual(1);
  });

  it('leaving the space turns the feed off and deletes busy times (L3)', async () => {
    const { sam, spaceId } = await couple();
    const on = await call('/feed', { token: sam.token, body: {} });
    const now = Date.now();
    await call('/feed/busy', {
      token: sam.token,
      method: 'PUT',
      body: { blocks: [{ start: now + 3_600_000, end: now + 7_200_000 }] },
    });
    await call(`/spaces/${spaceId}/membership`, { token: sam.token, method: 'DELETE' });
    expect((await getFeed(on.json.url)).status).toBe(404);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM feed_busy WHERE user_id = ?')
      .bind(sam.userId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe('calendar link relay', () => {
  it('only fetches public https calendar hosts', () => {
    const own = 'api.example';
    expect(
      isFetchableCalendarUrl('https://calendar.google.com/calendar/ical/x/basic.ics', own),
    ).toBe(true);
    expect(isFetchableCalendarUrl('https://p01-caldav.icloud.com:443/published/2/abc', own)).toBe(
      true,
    );
    for (const bad of [
      'http://calendar.example.com/a.ics',
      'https://127.0.0.1/a.ics',
      'https://10.0.0.1/a.ics',
      'https://[::1]/a.ics',
      'https://2130706433/a.ics',
      'https://localhost/a.ics',
      'https://printer.local/a.ics',
      'https://intranet/a.ics',
      'https://api.example/feed/x.ics',
      'https://API.EXAMPLE./feed/x.ics',
      'https://user:pw@calendar.example.com/a.ics',
      'https://calendar.example.com:8443/a.ics',
      'ftp://calendar.example.com/a.ics',
      'not a url',
    ]) {
      expect(isFetchableCalendarUrl(bad, own), bad).toBe(false);
    }
  });

  it('relays an iCalendar file and refuses anything else', async () => {
    const u = await signIn(uniqueEmail());
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (url.endsWith('/moved')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://cal.example.org/a.ics' },
        });
      }
      if (url.endsWith('/sneaky')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://127.0.0.1/admin' },
        });
      }
      if (url.endsWith('/page')) return new Response('<html>hi</html>');
      if (url.endsWith('/badloc')) {
        return new Response(null, { status: 302, headers: { Location: 'http://[::1' } });
      }
      if (url.endsWith('/gone')) return new Response('', { status: 404 });
      return new Response(ics, { headers: { 'Content-Type': 'text/calendar' } });
    });
    const ok = await call('/calendars/fetch', {
      token: u.token,
      body: { url: 'https://cal.example.org/moved' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toBe(ics);
    expect(seen).toEqual(['https://cal.example.org/moved', 'https://cal.example.org/a.ics']);

    const sneaky = await call('/calendars/fetch', {
      token: u.token,
      body: { url: 'https://cal.example.org/sneaky' },
    });
    expect(sneaky.status).toBe(422);
    expect(seen).not.toContain('https://127.0.0.1/admin');

    const page = await call('/calendars/fetch', {
      token: u.token,
      body: { url: 'https://cal.example.org/page' },
    });
    expect(page.json.error).toBe('not_a_calendar');
    const gone = await call('/calendars/fetch', {
      token: u.token,
      body: { url: 'https://cal.example.org/gone' },
    });
    expect(gone.status).toBe(502);
    const badloc = await call('/calendars/fetch', {
      token: u.token,
      body: { url: 'https://cal.example.org/badloc' },
    });
    expect(badloc.status).toBe(502);
    const anon = await call('/calendars/fetch', { body: { url: 'https://cal.example.org/a.ics' } });
    expect(anon.status).toBe(401);
  });

  it('refuses calendars over the size cap', async () => {
    const u = await signIn(uniqueEmail());
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(`BEGIN:VCALENDAR\r\n${'X'.repeat(5 * 1024 * 1024)}`, {
          headers: { 'Content-Type': 'text/calendar' },
        }),
    );
    const res = await call('/calendars/fetch', {
      token: u.token,
      body: { url: 'https://cal.example.org/huge.ics' },
    });
    expect(res.status).toBe(413);
  });
});
