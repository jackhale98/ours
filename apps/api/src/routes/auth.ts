// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sign-in. Accounts are created by email (magic link), which proves the
 * address; passkeys are then added and used for later sign-ins. See ADR 0012.
 *
 * /auth/email/start answers identically, and in the same time, whether or not
 * an account exists or an email is sent: the work happens after the response.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { Hono } from 'hono';
import * as v from 'valibot';
import { type AppEnv, createSession, endSession, requireAuth } from '../auth/session';
import type { Env } from '../env';
import { bytesOf, hashToken, newId, newToken } from '../lib/crypto';
import { sendEmail } from '../lib/email';
import { body, HttpError } from '../lib/http';
import { clientNet, rateLimit } from '../lib/ratelimit';
import { verifyTurnstile } from '../lib/turnstile';

const EMAIL_TOKEN_MINUTES = 15;
const CHALLENGE_MINUTES = 5;
const MAX_PASSKEYS = 10;
/** Adding a passkey needs a sign-in this recent (a stolen old session can't add one). */
const RECENT_SIGNIN_MS = 10 * 60_000;

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

/** In production (real email), refuse to run without a stable rate-limit salt. */
function requireProductionConfig(env: Env): void {
  if (env.EMAIL_PROVIDER === 'resend' && !env.RATE_LIMIT_SALT) {
    throw new HttpError(503, 'misconfigured', 'Sign-in is temporarily unavailable.');
  }
}

/** Whether invite-gated sign-up could apply (sign-ups not open). */
async function inviteUsable(env: Env, inviteId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM invites WHERE id = ? AND kind = 'partner' AND used_at IS NULL AND expires_at > ? AND claimed_by IS NULL",
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
  if (!row || (userId !== null && row.user_id !== userId)) {
    throw new HttpError(400, 'challenge_invalid');
  }
  return row.challenge;
}

export const auth = new Hono<AppEnv>();

/* ---------- email ---------- */

/** Issues a magic link if allowed. Runs after the response has been sent. */
async function issueLink(
  env: Env,
  input: { email: string; accept_terms: boolean; invite?: string | undefined },
): Promise<void> {
  // Per-address limit: past it, silently stop sending (no 429 that would let
  // anyone lock an address out, or reveal anything about it).
  try {
    await rateLimit(env, `email-start:addr:${input.email}`, 5, 3600);
  } catch {
    return;
  }
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(input.email)
    .first();
  const mayCreate =
    input.accept_terms &&
    (env.ALLOW_SIGNUPS === 'open' || (!!input.invite && (await inviteUsable(env, input.invite))));
  if (!existing && !mayCreate) return;
  const token = newToken();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO email_tokens (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await hashToken(token), input.email, now, now + EMAIL_TOKEN_MINUTES * 60_000)
    .run();
  const app = (env.APP_URL ?? rp(env, undefined).origin).replace(/\/?$/, '/');
  await sendEmail(env, {
    to: input.email,
    subject: 'Your Ours sign-in link',
    text: [
      'Tap to sign in to Ours:',
      '',
      `${app}#signin=${token}`,
      '',
      `This link works once and expires in ${EMAIL_TOKEN_MINUTES} minutes.`,
      'Using Ours from your iPhone or iPad Home Screen? Press and hold the link, choose Copy, and paste it into Ours.',
      'If you didn’t ask for it, ignore this email.',
    ].join('\n'),
  });
}

auth.post('/email/start', async (c) => {
  requireProductionConfig(c.env);
  const input = await body(
    c,
    v.object({
      email: Email,
      accept_terms: v.optional(v.boolean(), false),
      turnstile: v.optional(v.string()),
      invite: InviteId,
    }),
  );
  // Bot check before anything is counted, so unsolved requests can't burn limits.
  await verifyTurnstile(c.env, input.turnstile, c.req.header('CF-Connecting-IP'));
  await rateLimit(c.env, `email-start:ip:${clientNet(c)}`, 10, 3600);
  // Same answer, same timing, either way: the lookup and email happen after the response.
  c.executionCtx.waitUntil(
    issueLink(c.env, input).catch(() => {
      // Delivery problems are not reported back (that would leak account existence).
    }),
  );
  return c.json({ ok: true });
});

auth.post('/email/verify', async (c) => {
  const input = await body(
    c,
    v.object({ token: Token, device_label: DeviceLabel, invite: InviteId }),
  );
  await rateLimit(c.env, `email-verify:ip:${clientNet(c)}`, 20, 3600);
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
    const id = newId();
    if (c.env.ALLOW_SIGNUPS !== 'open') {
      // Invite-gated sign-up: claim the invite for this one new account,
      // atomically, so one invite can create at most one account.
      if (!input.invite) throw new HttpError(403, 'signups_closed');
      const claimed = await c.env.DB.prepare(
        `UPDATE invites SET claimed_by = ?1
          WHERE id = ?2 AND kind = 'partner' AND used_at IS NULL AND expires_at > ?3 AND claimed_by IS NULL
          RETURNING id`,
      )
        .bind(id, await hashToken(input.invite), Date.now())
        .first();
      if (!claimed) throw new HttpError(403, 'signups_closed');
    }
    user = { id, email: row.email };
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
  await endSession(c.env, c.var.session);
  return c.json({ ok: true });
});

/* ---------- passkeys ---------- */

auth.post('/passkey/register/options', requireAuth, async (c) => {
  const user = c.var.user;
  await rateLimit(c.env, `passkey-register:${user.id}`, 20, 3600);
  const signedIn = Math.max(c.var.session.created_at, c.var.session.reauth_at ?? 0);
  if (Date.now() - signedIn > RECENT_SIGNIN_MS) {
    throw new HttpError(403, 'reauth_required', 'Sign in again to add a passkey.');
  }
  const { rpID, rpName } = rp(c.env, c.req.header('Origin'));
  const existing = await c.env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?')
    .bind(user.id)
    .all<{ id: string; transports: string | null }>();
  if (existing.results.length >= MAX_PASSKEYS) {
    throw new HttpError(409, 'too_many_passkeys', 'Remove a passkey before adding another.');
  }
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
  const inserted = await c.env.DB.prepare(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at, aaguid)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      cred.id,
      c.var.user.id,
      cred.publicKey,
      cred.counter,
      cred.transports ? JSON.stringify(cred.transports) : null,
      Date.now(),
      verification.registrationInfo.aaguid ?? null,
    )
    .run();
  if (!inserted.meta.changes) throw new HttpError(409, 'passkey_exists');
  // Tell the owner, so a passkey added by someone else doesn't go unnoticed.
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: c.var.user.email,
      subject: 'A passkey was added to your Ours account',
      text: 'A new passkey was just added to your Ours account. If this wasn’t you, open Ours → Privacy, remove it, and sign out other devices.',
    }).catch(() => {}),
  );
  return c.json({ ok: true, id: cred.id });
});

auth.post('/passkey/login/options', async (c) => {
  await rateLimit(c.env, `passkey-login:ip:${clientNet(c)}`, 30, 600);
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
  await rateLimit(c.env, `passkey-verify:ip:${clientNet(c)}`, 30, 600);
  const { rpID, origins } = rp(c.env, c.req.header('Origin'));
  const expectedChallenge = await takeChallenge(c.env, input.challenge_id, 'login', null);
  const passkey = await verifyAssertion(c.env, input.response, expectedChallenge, rpID, origins);
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?')
    .bind(passkey.user_id)
    .first<{ id: string; email: string }>();
  if (!user) throw new HttpError(400, 'passkey_invalid');
  const session = await createSession(c.env, user.id, input.device_label, undefined, passkey.id);
  return c.json({ ...session, user, new_user: false });
});

/** Checks a passkey assertion and advances its counter. Returns the passkey's owner. */
async function verifyAssertion(
  env: Env,
  response: { id: string },
  expectedChallenge: string,
  rpID: string,
  origins: string[],
  requireUserVerification = false,
): Promise<{ id: string; user_id: string }> {
  const passkey = await env.DB.prepare(
    'SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?',
  )
    .bind(response.id)
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
      response: response as any,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: bytesOf(passkey.public_key),
        counter: passkey.counter,
        ...(passkey.transports ? { transports: JSON.parse(passkey.transports) } : {}),
      },
      requireUserVerification,
    });
  } catch {
    throw new HttpError(400, 'passkey_invalid');
  }
  if (!verification.verified) throw new HttpError(400, 'passkey_invalid');
  await env.DB.prepare('UPDATE passkeys SET counter = ? WHERE id = ?')
    .bind(verification.authenticationInfo.newCounter, passkey.id)
    .run();
  return { id: passkey.id, user_id: passkey.user_id };
}

/**
 * Confirm it's you, in this session (review 0005, M4): a passkey check that
 * marks the current session as recently signed in, for changing keys. No new
 * device or session is made.
 */
auth.post('/passkey/reauth/options', requireAuth, async (c) => {
  const uid = c.var.user.id;
  await rateLimit(c.env, `passkey-reauth:${uid}`, 20, 3600);
  const { rpID } = rp(c.env, c.req.header('Origin'));
  const mine = await c.env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?')
    .bind(uid)
    .all<{ id: string; transports: string | null }>();
  if (!mine.results.length) throw new HttpError(404, 'no_passkey');
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required', // the verify route requires it (review 0006, N1)
    allowCredentials: mine.results.map((p) => ({
      id: p.id,
      ...(p.transports ? { transports: JSON.parse(p.transports) } : {}),
    })),
  });
  const challengeId = await storeChallenge(c.env, options.challenge, 'login', uid);
  return c.json({ challenge_id: challengeId, options });
});

auth.post('/passkey/reauth/verify', requireAuth, async (c) => {
  const input = await body(
    c,
    v.object({ challenge_id: v.string(), response: v.looseObject({ id: v.string() }) }),
  );
  const uid = c.var.user.id;
  const { rpID, origins } = rp(c.env, c.req.header('Origin'));
  const expectedChallenge = await takeChallenge(c.env, input.challenge_id, 'login', uid);
  // A confirmation means face, fingerprint or passcode, checked (review 0006, M2).
  const passkey = await verifyAssertion(
    c.env,
    input.response,
    expectedChallenge,
    rpID,
    origins,
    true,
  );
  if (passkey.user_id !== uid) throw new HttpError(400, 'passkey_invalid');
  await c.env.DB.prepare('UPDATE sessions SET reauth_at = ?, passkey_id = ? WHERE token_hash = ?')
    .bind(Date.now(), passkey.id, c.var.session.token_hash)
    .run();
  return c.json({ ok: true });
});

/** The account's passkeys (id and when added). */
auth.get('/passkeys', requireAuth, async (c) => {
  // can_unlock: added after this person's latest change of keys (review 0006, M1).
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.created_at, p.aaguid,
            p.created_at > COALESCE(u.keys_changed_at, 0) AS can_unlock
       FROM passkeys p JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ? ORDER BY p.created_at`,
  )
    .bind(c.var.user.id)
    .all<{ id: string; created_at: number; aaguid: string | null; can_unlock: number }>();
  return c.json({
    passkeys: rows.results.map((r) => ({ ...r, can_unlock: !!r.can_unlock })),
  });
});

auth.delete('/passkeys/:id', requireAuth, async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), c.var.user.id)
    .run();
  if (!result.meta.changes) throw new HttpError(404, 'not_found');
  return c.json({ ok: true });
});
