// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import type { AppEnv } from './auth/session';
import type { Env } from './env';
import { devOutbox } from './lib/email';
import { HttpError } from './lib/http';
import { devPushes } from './push/send';
import { auth } from './routes/auth';
import { calendars } from './routes/calendars';
import { feed } from './routes/feed';
import { invites } from './routes/invites';
import { keys } from './routes/keys';
import { me } from './routes/me';
import { push } from './routes/push';
import { spaces } from './routes/spaces';
import { sync } from './routes/sync';

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function allowedOrigins(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );
}

export function createApp() {
  const app = new Hono<AppEnv>();

  // Strict CORS: only the configured web origins, bearer tokens only (no cookies).
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin');
    const allowed = origin !== undefined && allowedOrigins(c.env).has(origin);
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 403);
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
    }
    await next();
    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
  });

  // Security headers and coarse logging: route, method, status, latency. Never bodies, tokens or ids.
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    console.warn(
      JSON.stringify({
        route: c.req.routePath,
        method: c.req.method,
        status: c.res.status,
        ms: Date.now() - started,
      }),
    );
  });

  app.get('/health', (c) => c.json({ ok: true }));
  // Local end-to-end tests only (see lib/email.ts). 404 unless explicitly enabled.
  app.get('/dev/outbox', (c) => {
    // Belt and braces: even if the provider were misconfigured on a deployed
    // Worker, only requests to a local host are answered.
    const host = new URL(c.req.url).hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (c.env.EMAIL_PROVIDER !== 'dev-outbox' || !local) return c.json({ error: 'not_found' }, 404);
    const to = c.req.query('to');
    return c.json(devOutbox.filter((m) => !to || m.to === to.toLowerCase()));
  });
  app.get('/dev/pushes', (c) => {
    const host = new URL(c.req.url).hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (c.env.EMAIL_PROVIDER !== 'dev-outbox' || !local) return c.json({ error: 'not_found' }, 404);
    return c.json(devPushes);
  });
  app.route('/auth', auth);
  app.route('/', me);
  app.route('/spaces', spaces);
  app.route('/invites', invites);
  app.route('/keys', keys);
  app.route('/sync', sync);
  app.route('/push', push);
  app.route('/feed', feed);
  app.route('/calendars', calendars);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError)
      return c.json({ error: err.code, message: err.message }, err.status);
    console.error(JSON.stringify({ route: c.req.routePath, error: 'internal' }));
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}

/** Hourly housekeeping: expired tokens, challenges, invites, sessions, old rate-limit windows. */
export async function cleanup(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_tokens WHERE expires_at < ?').bind(now - 86_400_000),
    env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM invites WHERE expires_at < ? OR used_at < ?').bind(
      now,
      now - 86_400_000,
    ),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    // Push subscriptions of devices that are no longer signed in (review L4).
    env.DB.prepare(
      'DELETE FROM push_subs WHERE device_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = push_subs.device_id AND s.expires_at > ?)',
    ).bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(
      Math.floor(now / 1000) - 86_400,
    ),
  ]);
}
