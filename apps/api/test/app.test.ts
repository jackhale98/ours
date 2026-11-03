// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const call = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://api.example${path}`, init));

describe('app shell', () => {
  it('answers health checks with security headers', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('allows CORS only for configured origins', async () => {
    const ok = await call('/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
    expect(ok.headers.get('Access-Control-Allow-Credentials')).toBeNull();

    const evil = await call('/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    const get = await call('/health', { headers: { Origin: 'https://evil.example' } });
    expect(get.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('returns JSON 404s', async () => {
    const res = await call('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('applies the schema, including the scope/owner constraint', async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all();
    expect(tables.results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'records',
        'spaces',
        'memberships',
        'invites',
        'key_backups',
        'sessions',
      ]),
    );
    await env.DB.prepare('INSERT INTO spaces (id, created_at) VALUES (?, ?)').bind('s1', 1).run();
    const bad = env.DB.prepare(
      `INSERT INTO records (id, space_id, scope, owner_user_id, key_version, nonce, ciphertext, rev, updated_at, updated_by)
       VALUES ('r1', 's1', 'user', NULL, 1, x'00', x'00', 1, 1, 'u1')`,
    ).run();
    await expect(bad).rejects.toThrow();
  });
});
