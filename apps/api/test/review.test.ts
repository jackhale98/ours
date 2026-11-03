// SPDX-License-Identifier: AGPL-3.0-or-later
/** Regression tests for the phase 2 security review (docs/reviews/0002-api.md). */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSession } from '../src/auth/session';
import { setSender } from '../src/lib/email';
import { call, couple, envelope, outbox, randomB64, signIn, uniqueEmail } from './helpers';

const wrapped = () => ({ nonce: randomB64(24), ciphertext: randomB64(120) });
const withEnv = async (patch: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const e = env as unknown as Record<string, string | undefined>;
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, e[k]]));
  Object.assign(e, patch);
  try {
    await fn();
  } finally {
    Object.assign(e, saved);
  }
};

describe('H2: one invite creates at most one account when sign-ups are restricted', () => {
  it('a second sign-up with the same invite is refused', async () => {
    const sam = await signIn(uniqueEmail());
    const space = (await call('/spaces', { token: sam.token, body: {} })).json.id;
    const inv = (
      await call('/invites', {
        token: sam.token,
        body: { kind: 'partner', space_id: space, wrapped: wrapped() },
      })
    ).json.id;
    await withEnv({ ALLOW_SIGNUPS: 'closed' }, async () => {
      const alex = await signIn(uniqueEmail(), { invite: inv });
      expect(alex.token).toHaveLength(43);
      await expect(signIn(uniqueEmail(), { invite: inv })).rejects.toThrow();
      // The account it created is the one that can open the invite.
      expect((await call(`/invites/${inv}`, { token: alex.token })).status).toBe(200);
    });
  });
});

describe('M1: the device cap never locks anyone out', () => {
  // Sessions are created directly: the per-address email limit (5/hour) would
  // otherwise stop the test before the device cap is reached.
  it('sign-in keeps working after many sign-in/sign-out cycles', async () => {
    const first = await signIn(uniqueEmail());
    await call('/auth/logout', { token: first.token, body: {} });
    for (let i = 0; i < 12; i++) {
      const s = await createSession(env, first.userId, 'Phone');
      expect((await call('/auth/logout', { token: s.token, body: {} })).status).toBe(200);
    }
    const s = await createSession(env, first.userId, 'Phone');
    const me = await call('/me', { token: s.token });
    expect(me.json.devices).toHaveLength(1);
  });

  it('at the cap, the least recently seen device makes room', async () => {
    const first = await signIn(uniqueEmail());
    const tokens: string[] = [first.token];
    for (let i = 0; i < 10; i++) {
      await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE user_id = ?')
        .bind(i, first.userId)
        .run();
      tokens.push((await createSession(env, first.userId, 'Phone')).token);
    }
    const me = await call('/me', { token: tokens.at(-1) ?? '' });
    expect(me.json.devices.length).toBeLessThanOrEqual(10);
    expect((await call('/me', { token: tokens[0] ?? '' })).status).toBe(401);
  });
});

describe('M2/M3: bot check first, no timing leak', () => {
  it('requests that fail the bot check are not counted against an address', async () => {
    await withEnv({ TURNSTILE_SECRET: 'test-secret' }, async () => {
      const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits').first<{
        n: number;
      }>();
      const res = await call('/auth/email/start', {
        body: { email: uniqueEmail(), accept_terms: true },
      });
      expect(res.status).toBe(403);
      const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits').first<{
        n: number;
      }>();
      expect(after?.n).toBe(before?.n);
    });
  });

  it('answers before any email work is done', async () => {
    const email = uniqueEmail();
    await signIn(email); // existing account
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setSender(async () => {
      await gate;
    });
    try {
      const started = Date.now();
      const res = await Promise.race([
        call('/auth/email/start', { body: { email } }),
        new Promise<null>((r) => setTimeout(() => r(null), 2000)),
      ]);
      expect(res?.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      release();
      setSender(async (_env, m) => {
        outbox.push(m);
      });
    }
  });
});

describe('M4: passkeys can be listed and removed; adding one needs a recent sign-in', () => {
  it('lists and deletes passkeys; refuses an old session', async () => {
    const s = await signIn(uniqueEmail());
    expect((await call('/auth/passkeys', { token: s.token })).json.passkeys).toEqual([]);
    await env.DB.prepare(
      "INSERT INTO passkeys (id, user_id, public_key, counter, created_at) VALUES ('pk1', ?, x'00', 0, 1)",
    )
      .bind(s.userId)
      .run();
    expect(
      (await call('/auth/passkeys', { token: s.token })).json.passkeys.map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual(['pk1']);
    const other = await signIn(uniqueEmail());
    expect(
      (await call('/auth/passkeys/pk1', { method: 'DELETE', token: other.token })).status,
    ).toBe(404);
    expect((await call('/auth/passkeys/pk1', { method: 'DELETE', token: s.token })).status).toBe(
      200,
    );

    await env.DB.prepare('UPDATE sessions SET created_at = 1 WHERE user_id = ?')
      .bind(s.userId)
      .run();
    const old = await call('/auth/passkey/register/options', { token: s.token, body: {} });
    expect(old.json.error).toBe('reauth_required');
  });
});

describe('M5: quotas hold under races and joins', () => {
  it('parallel space creation cannot exceed the cap', async () => {
    const s = await signIn(uniqueEmail());
    const results = await Promise.all(
      Array.from({ length: 6 }, () => call('/spaces', { token: s.token, body: {} })),
    );
    expect(results.filter((r) => r.status === 201).length).toBeLessThanOrEqual(3);
    const me = await call('/me', { token: s.token });
    expect(me.json.spaces.length).toBeLessThanOrEqual(3);
  });

  it('joining respects the joiner’s space cap and leaves the invite usable on failure', async () => {
    const full = await signIn(uniqueEmail());
    for (let i = 0; i < 3; i++) await call('/spaces', { token: full.token, body: {} });
    const sam = await signIn(uniqueEmail());
    const space = (await call('/spaces', { token: sam.token, body: {} })).json.id;
    const inv = (
      await call('/invites', {
        token: sam.token,
        body: { kind: 'partner', space_id: space, wrapped: wrapped() },
      })
    ).json.id;
    await call(`/invites/${inv}`, { token: full.token });
    const res = await call(`/invites/${inv}/accept`, { token: full.token, body: {} });
    expect(res.json.error).toBe('cannot_join');
    const row = await env.DB.prepare(
      'SELECT used_at, length(wrapped) AS n FROM invites WHERE space_id = ?',
    )
      .bind(space)
      .first<{ used_at: number | null; n: number }>();
    expect(row?.used_at).toBeNull();
    expect(row?.n).toBeGreaterThan(0);
  });

  it('charges a per-row overhead so tiny records count', async () => {
    const { sam, spaceId } = await couple();
    const items = Array.from({ length: 10 }, () => ({
      envelope: envelope(spaceId, { size: 64 }),
      base_rev: 0,
    }));
    await call('/sync/push', { token: sam.token, body: { space_id: spaceId, items } });
    const row = await env.DB.prepare('SELECT bytes FROM spaces WHERE id = ?')
      .bind(spaceId)
      .first<{ bytes: number }>();
    expect(row?.bytes).toBe(10 * (64 + 24 + 256));
  });
});

describe('L5: account deletion leaves no trace of the id', () => {
  it('clears updated_by and claimed_by', async () => {
    const { sam, alex, spaceId } = await couple();
    const e = envelope(spaceId);
    await call('/sync/push', {
      token: alex.token,
      body: { space_id: spaceId, items: [{ envelope: e, base_rev: 0 }] },
    });
    await call('/me', { method: 'DELETE', token: alex.token });
    const rec = await env.DB.prepare('SELECT updated_by FROM records WHERE id = ?')
      .bind(e.id)
      .first<{ updated_by: string }>();
    expect(rec?.updated_by).toBe('deleted');
    const inv = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE claimed_by = ?')
      .bind(alex.userId)
      .first<{ n: number }>();
    expect(inv?.n).toBe(0);
    void sam;
  });
});

describe('L2: request bodies are capped while streaming', () => {
  it('rejects bodies over 1 MB', async () => {
    const res = await call('/auth/email/start', {
      body: { email: 'a@b.co', pad: 'x'.repeat(1_100_000) },
    });
    expect(res.status).toBe(413);
  });
});
