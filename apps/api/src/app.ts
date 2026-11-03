// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono';
import type { Env } from './env';

export type AppEnv = { Bindings: Env };

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

  // Security headers and coarse logging: route, status, latency. Never bodies.
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

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((_err, c) => c.json({ error: 'internal' }, 500));

  return app;
}
