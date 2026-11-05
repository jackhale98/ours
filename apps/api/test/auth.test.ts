// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, nextMail, outbox, signIn, uniqueEmail } from './helpers';

describe('email sign-in', () => {
  it('creates an account, a device and a session', async () => {
    const email = uniqueEmail();
    const s = await signIn(email);
    const me = await call('/me', { token: s.token });
    expect(me.status).toBe(200);
    expect(me.json.user.email).toBe(email);
    expect(me.json.devices).toHaveLength(1);
    expect(me.json.device_id).toBe(s.deviceId);
    // Tokens are stored hashed, never raw.
    const row = await env.DB.prepare('SELECT token_hash FROM sessions WHERE user_id = ?')
      .bind(s.userId)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).not.toBe(s.token);
  });

  it('normalises the address and signs into the same account', async () => {
    const email = uniqueEmail();
    const a = await signIn(email);
    const b = await signIn(`  ${email.toUpperCase()} `.trim().toUpperCase());
    expect(b.userId).toBe(a.userId);
  });

  it('answers the same whether or not an account exists, and only emails when allowed', async () => {
    const before = outbox.length;
    const unknown = await call('/auth/email/start', {
      body: { email: uniqueEmail(), accept_terms: false },
    });
    expect(unknown.status).toBe(200);
    expect(unknown.json).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(outbox.length).toBe(before); // new address without accepting terms: no account, no email
  });

  it('links work once and expire', async () => {
    const email = uniqueEmail();
    const before = outbox.length;
    await call('/auth/email/start', { body: { email, accept_terms: true } });
    const token = /#signin=([A-Za-z0-9_-]{43})/.exec((await nextMail(before))?.text ?? '')?.[1];
    expect((await call('/auth/email/verify', { body: { token } })).status).toBe(200);
    const again = await call('/auth/email/verify', { body: { token } });
    expect(again.json.error).toBe('link_invalid');
    expect(again.json.message).toMatch(/already used/);

    const before2 = outbox.length;
    await call('/auth/email/start', { body: { email } });
    const t2 = /#signin=([A-Za-z0-9_-]{43})/.exec((await nextMail(before2))?.text ?? '')?.[1];
    await env.DB.prepare('UPDATE email_tokens SET expires_at = 1 WHERE used_at IS NULL').run();
    const late = await call('/auth/email/verify', { body: { token: t2 } });
    expect(late.json.error).toBe('link_invalid');
    expect(late.json.message).toMatch(/expired/);
  });

  it('a code from the email signs in where the link can’t be opened', async () => {
    const email = uniqueEmail();
    const before = outbox.length;
    await call('/auth/email/start', { body: { email, accept_terms: true } });
    const mail = await nextMail(before);
    const code = /^\s+(\d{6})$/m.exec(mail?.text ?? '')?.[1];
    expect(code).toMatch(/^\d{6}$/);
    // Not in the subject (lock-screen previews); bound to the site for autofill.
    expect(mail?.subject).not.toContain(code);
    expect(mail?.text).toMatch(new RegExp(`\\n@[^ ]+ #${code}$`));
    // Codes are kept only as a keyed hash.
    const row = await env.DB.prepare('SELECT code_hash FROM email_tokens WHERE email = ?')
      .bind(email)
      .first<{ code_hash: string }>();
    expect(row?.code_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.code_hash).not.toContain(code as string);

    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    const bad = await call('/auth/email/code', { body: { email, code: wrong } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('code_invalid');
    const ok = await call('/auth/email/code', {
      body: { email: email.toUpperCase(), code, device_label: 'Test' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.user.email).toBe(email);
    // Once used, neither the code nor the link works again.
    expect((await call('/auth/email/code', { body: { email, code } })).json.error).toBe(
      'code_invalid',
    );
    const token = /#signin=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '')?.[1];
    expect((await call('/auth/email/verify', { body: { token } })).json.message).toMatch(
      /already used/,
    );
  });

  it('a code stops working after five wrong tries, and only the newest counts', async () => {
    const email = uniqueEmail();
    const before = outbox.length;
    await call('/auth/email/start', { body: { email, accept_terms: true } });
    const first = /^\s+(\d{6})$/m.exec((await nextMail(before))?.text ?? '')?.[1] as string;
    const before2 = outbox.length;
    await call('/auth/email/start', { body: { email, accept_terms: true } });
    const second = /^\s+(\d{6})$/m.exec((await nextMail(before2))?.text ?? '')?.[1] as string;
    if (first !== second) {
      // An older email's code isn't accepted once a newer one was sent.
      expect((await call('/auth/email/code', { body: { email, code: first } })).status).toBe(400);
    }
    const wrong = String((Number(second) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i++) await call('/auth/email/code', { body: { email, code: wrong } });
    const late = await call('/auth/email/code', { body: { email, code: second } });
    expect(late.status).toBe(400);
    expect(late.json.error).toBe('code_invalid');
    // An address with no code pending gets the same answer.
    const none = await call('/auth/email/code', { body: { email: uniqueEmail(), code: '123456' } });
    expect(none.json).toEqual(late.json);
  });

  it('after too many wrong codes an address gets links only, until it signs in', async () => {
    const email = uniqueEmail();
    await signIn(email);
    const { opaqueKey } = await import('../src/lib/ratelimit');
    const key = await opaqueKey(env, `code-failures:${email}`);
    await env.DB.prepare('INSERT INTO code_failures (key, n, updated_at) VALUES (?, 100, ?)')
      .bind(key, Date.now())
      .run();
    const before = outbox.length;
    await call('/auth/email/start', { body: { email } });
    const mail = await nextMail(before);
    expect(mail?.text).toMatch(/link only/);
    expect(mail?.text).not.toMatch(/^\s+\d{6}$/m);
    expect((await call('/auth/email/code', { body: { email, code: '000000' } })).status).toBe(400);
    // Signing in with the link clears the count.
    const token = /#signin=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '')?.[1];
    expect((await call('/auth/email/verify', { body: { token } })).status).toBe(200);
    expect(
      await env.DB.prepare('SELECT n FROM code_failures WHERE key = ?').bind(key).first(),
    ).toBeNull();
  });

  it('limits code attempts per address, whoever asks', async () => {
    const email = uniqueEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await call('/auth/email/code', { body: { email, code: '000000' } })).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('rejects malformed input', async () => {
    expect((await call('/auth/email/start', { body: { email: 'not-an-email' } })).status).toBe(422);
    expect((await call('/auth/email/start', { body: '{' })).status).toBe(422);
    const raw = await call('/auth/email/verify', { body: { token: 'short' } });
    expect(raw.status).toBe(422);
  });

  it('limits links per address silently (no 429 that could lock someone out)', async () => {
    const email = uniqueEmail();
    const before = outbox.length;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push(
        (await call('/auth/email/start', { body: { email, accept_terms: true } })).status,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(outbox.slice(before).filter((m) => m.to === email)).toHaveLength(5);
  });
});

describe('sessions', () => {
  it('requires a valid bearer token', async () => {
    expect((await call('/me')).status).toBe(401);
    expect((await call('/me', { token: 'A'.repeat(43) })).status).toBe(401);
    expect((await call('/me', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('logout ends the session', async () => {
    const s = await signIn(uniqueEmail());
    expect((await call('/auth/logout', { token: s.token, body: {} })).status).toBe(200);
    expect((await call('/me', { token: s.token })).status).toBe(401);
  });

  it('expired sessions are rejected', async () => {
    const s = await signIn(uniqueEmail());
    await env.DB.prepare('UPDATE sessions SET expires_at = 1 WHERE user_id = ?')
      .bind(s.userId)
      .run();
    expect((await call('/me', { token: s.token })).status).toBe(401);
  });

  it('removing a device ends its sessions', async () => {
    const email = uniqueEmail();
    const phone = await signIn(email);
    const laptop = await signIn(email);
    const r = await call(`/devices/${laptop.deviceId}`, { method: 'DELETE', token: phone.token });
    expect(r.status).toBe(200);
    expect((await call('/me', { token: laptop.token })).status).toBe(401);
    expect((await call('/me', { token: phone.token })).status).toBe(200);
    // Someone else's device id: 404.
    const other = await signIn(uniqueEmail());
    expect(
      (await call(`/devices/${phone.deviceId}`, { method: 'DELETE', token: other.token })).status,
    ).toBe(404);
  });
});

describe('cleanup', () => {
  it('removes expired tokens and sessions', async () => {
    const { cleanup } = await import('../src/app');
    await env.DB.prepare(
      "INSERT INTO email_tokens (token_hash, email, created_at, expires_at) VALUES ('x', 'a@b.c', 1, 2)",
    ).run();
    await cleanup(env, Date.now());
    expect(
      await env.DB.prepare("SELECT 1 FROM email_tokens WHERE token_hash = 'x'").first(),
    ).toBeNull();
  });
});

describe('privacy of rate limiting', () => {
  it('never stores IP or email addresses in rate-limit keys', async () => {
    const email = uniqueEmail();
    await call('/auth/email/start', { body: { email, accept_terms: true }, ip: '203.0.113.7' });
    const rows = await env.DB.prepare('SELECT key FROM rate_limits').all<{ key: string }>();
    const keys = rows.results.map((r) => r.key).join(' ');
    expect(keys).not.toContain('203.0.113.7');
    expect(keys).not.toContain(email);
    expect(rows.results.every((r) => /^[0-9a-f]{32}$/.test(r.key))).toBe(true);
  });
});
