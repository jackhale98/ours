// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sign-in. Accounts are created by email (magic link), which proves the
 * address; passkeys are then added and used for later sign-ins. See ADR 0012.
 *
 * Responses to /auth/email/start are identical whether or not an account
 * exists, so the endpoint cannot be used to discover who has an account.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, createSession, requireAuth } from '../auth/session';
import type { Env } from '../env';
import { bytesOf, hashToken, newId, newToken } from '../lib/crypto';
import { sendEmail } from '../lib/email';
import { body, HttpError } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { verifyTurnstile } from '../lib/turnstile';

const EMAIL_TOKEN_MINUTES = 15;
const CHALLENGE_MINUTES = 5;

const Email = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.maxLength(254),
  v.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);
const DeviceLabel = v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60)), 'Browser');
const Token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const InviteId = v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,64}$/)));

const ip = (c: { req: { header(n: string): string | undefined } }) =>
  c.req.header('CF-Connecting-IP') ?? 'unknown';

/** Whether a new account may be created right now (sign-up policy, ADR 0012). */
async function canCreateAccount(env: Env, inviteId: string | undefined): Promise<boolean> {
  if (env.ALLOW_SIGNUPS === 'open') return true;
  // Partners joining through a valid invite can always sign up.
  if (!inviteId) return false;
  const row = await env.DB.prepare(
    "SELECT 1 FROM invites WHERE id = ? AND kind = 'partner' AND used_at IS NULL AND expires_at > ?",
  )
    .bind(await hashToken(inviteId), Date.now())
    .first();
  return !!row;
}

function rp(env: Env, origin: string | undefined) {
  const allowed = env.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const first = allowed[0] ?? 'http://localhost:5173';
  return {
    rpID: env.RP_ID ?? new URL(first).hostname,
    rpName: env.RP_NAME ?? 'Ours',
    origins: allowed,
    origin: origin && allowed.includes(origin) ? origin : first,
  };
}

async function storeChallenge(
  env: Env,
  challenge: string,
  purpose: 'register' | 'login',
  userId: string | null,
) {
  const id = newId();
  await env.DB.prepare(
    'INSERT INTO auth_challenges (id, user_id, challenge, purpose, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, userId, challenge, purpose, Date.now() + CHALLENGE_MINUTES * 60_000)
    .run();
  return id;
}

/** Single use: the challenge row is deleted as it is read. */
async function takeChallenge(
  env: Env,
  id: string,
  purpose: 'register' | 'login',
  userId: string | null,
) {
  const row = await env.DB.prepare(
    'DELETE FROM auth_challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING challenge, user_id',
  )
    .bind(id, purpose, Date.now())
    .first<{ challenge: string; user_id: string | null }>();
  if (!row || (userId !== null && row.user_id !== userId))
    throw new HttpError(400, 'challenge_invalid');
  return row.challenge;
}

export const auth = new Hono<AppEnv>();

/* ---------- email ---------- */

auth.post('/email/start', async (c) => {
  const input = await body(
    c,
    v.object({
      email: Email,
      accept_terms: v.optional(v.boolean(), false),
      turnstile: v.optional(v.string()),
      invite: InviteId,
    }),
  );
  await rateLimit(c.env, `email-start:ip:${ip(c)}`, 10, 3600);
  await rateLimit(c.env, `email-start:addr:${input.email}`, 5, 3600);
  await verifyTurnstile(c.env, input.turnstile, ip(c));

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(input.email)
    .first();
  const allowed = existing || (input.accept_terms && (await canCreateAccount(c.env, input.invite)));
  if (allowed) {
    const token = newToken();
    const now = Date.now();
    await c.env.DB.prepare(
      'INSERT INTO email_tokens (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(await hashToken(token), input.email, now, now + EMAIL_TOKEN_MINUTES * 60_000)
      .run();
    const app = (c.env.APP_URL ?? rp(c.env, undefined).origin).replace(/\/?$/, '/');
    await sendEmail(c.env, {
      to: input.email,
      subject: 'Your Ours sign-in link',
      text: [
        'Tap to sign in to Ours:',
        '',
        `${app}#signin=${token}`,
        '',
        `This link works once and expires in ${EMAIL_TOKEN_MINUTES} minutes.`,
        'If you didn’t ask for it, ignore this email.',
      ].join('\n'),
    });
  }
  // Same answer either way: no account enumeration.
  return c.json({ ok: true });
});

auth.post('/email/verify', async (c) => {
  const input = await body(
    c,
    v.object({ token: Token, device_label: DeviceLabel, invite: InviteId }),
  );
  await rateLimit(c.env, `email-verify:ip:${ip(c)}`, 20, 3600);
  const row = await c.env.DB.prepare(
    `UPDATE email_tokens SET used_at = ?1
      WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1
      RETURNING email`,
  )
    .bind(Date.now(), await hashToken(input.token))
    .first<{ email: string }>();
  if (!row) throw new HttpError(400, 'link_invalid', 'That link has expired or was already used.');

  let user = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(row.email)
    .first<{ id: string; email: string }>();
  let created = false;
  if (!user) {
    if (!(await canCreateAccount(c.env, input.invite))) throw new HttpError(403, 'signups_closed');
    user = { id: newId(), email: row.email };
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, created_at, last_active) VALUES (?, ?, ?, ?)',
    )
      .bind(user.id, user.email, Date.now(), Date.now())
      .run();
    created = true;
  }
  const session = await createSession(c.env, user.id, input.device_label);
  return c.json({ ...session, user, new_user: created });
});

auth.post('/logout', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(c.var.session.token_hash)
    .run();
  return c.json({ ok: true });
});

/* ---------- passkeys ---------- */

auth.post('/passkey/register/options', requireAuth, async (c) => {
  const { rpID, rpName } = rp(c.env, c.req.header('Origin'));
  const user = c.var.user;
  const existing = await c.env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?')
    .bind(user.id)
    .all<{ id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userID: Uint8Array.from(new TextEncoder().encode(user.id)),
    attestationType: 'none',
    excludeCredentials: existing.results.map((p) => ({
      id: p.id,
      ...(p.transports ? { transports: JSON.parse(p.transports) } : {}),
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const challengeId = await storeChallenge(c.env, options.challenge, 'register', user.id);
  return c.json({ challenge_id: challengeId, options });
});

auth.post('/passkey/register/verify', requireAuth, async (c) => {
  const input = await body(
    c,
    v.object({ challenge_id: v.string(), response: v.looseObject({ id: v.string() }) }),
  );
  const { rpID, origins } = rp(c.env, c.req.header('Origin'));
  const expectedChallenge = await takeChallenge(
    c.env,
    input.challenge_id,
    'register',
    c.var.user.id,
  );
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      // biome-ignore lint/suspicious/noExplicitAny: shape validated by the library
      response: input.response as any,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch {
    throw new HttpError(400, 'passkey_invalid');
  }
  if (!verification.verified) throw new HttpError(400, 'passkey_invalid');
  const cred = verification.registrationInfo.credential;
  await c.env.DB.prepare(
    'INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      cred.id,
      c.var.user.id,
      cred.publicKey,
      cred.counter,
      cred.transports ? JSON.stringify(cred.transports) : null,
      Date.now(),
    )
    .run();
  return c.json({ ok: true, id: cred.id });
});

auth.post('/passkey/login/options', async (c) => {
  await rateLimit(c.env, `passkey-login:ip:${ip(c)}`, 30, 600);
  const { rpID } = rp(c.env, c.req.header('Origin'));
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  const challengeId = await storeChallenge(c.env, options.challenge, 'login', null);
  return c.json({ challenge_id: challengeId, options });
});

auth.post('/passkey/login/verify', async (c) => {
  const input = await body(
    c,
    v.object({
      challenge_id: v.string(),
      response: v.looseObject({ id: v.string() }),
      device_label: DeviceLabel,
    }),
  );
  await rateLimit(c.env, `passkey-verify:ip:${ip(c)}`, 30, 600);
  const { rpID, origins } = rp(c.env, c.req.header('Origin'));
  const expectedChallenge = await takeChallenge(c.env, input.challenge_id, 'login', null);
  const passkey = await c.env.DB.prepare(
    'SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?',
  )
    .bind(input.response.id)
    .first<{
      id: string;
      user_id: string;
      public_key: ArrayBuffer;
      counter: number;
      transports: string | null;
    }>();
  if (!passkey) throw new HttpError(400, 'passkey_invalid');
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      // biome-ignore lint/suspicious/noExplicitAny: shape validated by the library
      response: input.response as any,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: bytesOf(passkey.public_key),
        counter: passkey.counter,
        ...(passkey.transports ? { transports: JSON.parse(passkey.transports) } : {}),
      },
      requireUserVerification: false,
    });
  } catch {
    throw new HttpError(400, 'passkey_invalid');
  }
  if (!verification.verified) throw new HttpError(400, 'passkey_invalid');
  await c.env.DB.prepare('UPDATE passkeys SET counter = ? WHERE id = ?')
    .bind(verification.authenticationInfo.newCounter, passkey.id)
    .run();
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?')
    .bind(passkey.user_id)
    .first<{ id: string; email: string }>();
  if (!user) throw new HttpError(400, 'passkey_invalid');
  const session = await createSession(c.env, user.id, input.device_label);
  return c.json({ ...session, user, new_user: false });
});
