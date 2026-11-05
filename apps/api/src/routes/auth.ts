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
import { type Env, num } from '../env';
import { bytesOf, hashToken, newId, newToken } from '../lib/crypto';
import { sendEmail } from '../lib/email';
import { body, HttpError } from '../lib/http';
import { clientNet, rateLimit } from '../lib/ratelimit';
import { verifyTurnstile } from '../lib/turnstile';

const EMAIL_TOKEN_MINUTES = 15;
/** Wrong guesses a sign-in code allows before it stops working. */
const CODE_TRIES = 5;
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
const Code = v.pipe(v.string(), v.regex(/^\d{6}$/));
const InviteId = v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,64}$/)));

/** In production (real email), refuse to run without a stable rate-limit salt. */
function requireProductionConfig(env: Env): void {
  if (env.EMAIL_PROVIDER === 'resend' && !env.RATE_LIMIT_SALT) {
    throw new HttpError(503, 'misconfigured', 'Sign-in is temporarily unavailable.');
  }
}

/**
 * A six-digit sign-in code, uniformly random. Stored only as a hash keyed by
 * the server's secret and the row's token hash, so a copy of the database
 * alone can't be searched for it.
 */
function newCode(): string {
  const n = new Uint32Array(1);
  // Rejection sampling: no bias toward low codes.
  do crypto.getRandomValues(n);
  while ((n[0] as number) >= 4_294_000_000);
  return String((n[0] as number) % 1_000_000).padStart(6, '0');
}
const codeHash = (env: Env, tokenHash: string, code: string) =>
  hashToken(`ours/signin-code/v1|${env.RATE_LIMIT_SALT ?? ''}|${tokenHash}|${code}`);

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
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
  const code = newCode();
  const tokenHash = await hashToken(token);
  const now = Date.now();
  // The invite presented now is the one opening the link uses (review 0007, I11).
  await env.DB.prepare(
    'INSERT INTO email_tokens (token_hash, email, created_at, expires_at, invite_hash, code_hash) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      tokenHash,
      input.email,
      now,
      now + EMAIL_TOKEN_MINUTES * 60_000,
      input.invite ? await hashToken(input.invite) : null,
      await codeHash(env, tokenHash, code),
    )
    .run();
  const app = (env.APP_URL ?? rp(env, undefined).origin).replace(/\/?$/, '/');
  await sendEmail(env, {
    to: input.email,
    subject: `Your Ours sign-in code: ${code}`,
    text: [
      'Type this code where you asked to sign in:',
      '',
      `    ${code}`,
      '',
      'Or tap to sign in on this device:',
      '',
      `${app}#signin=${token}`,
      '',
      `The code and link work once and expire in ${EMAIL_TOKEN_MINUTES} minutes.`,
      'If you didn’t ask for them, ignore this email.',
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
  await rateLimit(c.env, `email-start:ip:${clientNet(c)}`, num(c.env.EMAIL_START_PER_IP, 10), 3600);
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
      RETURNING email, invite_hash`,
  )
    .bind(Date.now(), await hashToken(input.token))
    .first<{ email: string; invite_hash: string | null }>();
  if (!row) {
    // Say which, to help whoever holds the link (only they can ask about it).
    const seen = await c.env.DB.prepare('SELECT used_at FROM email_tokens WHERE token_hash = ?')
      .bind(await hashToken(input.token))
      .first<{ used_at: number | null }>();
    throw new HttpError(
      400,
      'link_invalid',
      seen?.used_at
        ? 'That link was already used. Each one works once: if you didn’t get signed in, ask for a new one here.'
        : 'That link has expired. Ask for a new one here.',
    );
  }

  return c.json(await finishEmailSignIn(c.env, row, input));
});

auth.post('/email/code', async (c) => {
  const input = await body(
    c,
    v.object({ email: Email, code: Code, device_label: DeviceLabel, invite: InviteId }),
  );
  await rateLimit(c.env, `email-verify:ip:${clientNet(c)}`, 20, 3600);
  const now = Date.now();
  // The newest code sent to this address, counting this guess first so that
  // concurrent guesses can't share a try.
  const pending = await c.env.DB.prepare(
    `UPDATE email_tokens SET code_tries = code_tries + 1
      WHERE token_hash = (
        SELECT token_hash FROM email_tokens
         WHERE email = ?1 AND used_at IS NULL AND expires_at > ?2 AND code_hash IS NOT NULL
         ORDER BY created_at DESC LIMIT 1)
        AND code_tries < ?3
      RETURNING token_hash, code_hash`,
  )
    .bind(input.email, now, CODE_TRIES)
    .first<{ token_hash: string; code_hash: string }>();
  // One answer for "no code", "too many tries" and "wrong": nothing about the
  // address or its codes is revealed to someone guessing.
  const refuse = () =>
    new HttpError(
      400,
      'code_invalid',
      'That code isn’t right, or it has expired. Use the newest email, or ask for a new code.',
    );
  if (!pending) throw refuse();
  if (!sameText(await codeHash(c.env, pending.token_hash, input.code), pending.code_hash))
    throw refuse();
  const row = await c.env.DB.prepare(
    `UPDATE email_tokens SET used_at = ?1
      WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1
      RETURNING email, invite_hash`,
  )
    .bind(Date.now(), pending.token_hash)
    .first<{ email: string; invite_hash: string | null }>();
  if (!row) throw refuse();
  return c.json(await finishEmailSignIn(c.env, row, input));
});

/** After a link or code checks out: the account (made if new) and a session. */
async function finishEmailSignIn(
  env: Env,
  row: { email: string; invite_hash: string | null },
  input: { device_label: string; invite?: string | undefined },
) {
  let user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(row.email)
    .first<{ id: string; email: string }>();
  let created = false;
  if (!user) {
    const id = newId();
    if (env.ALLOW_SIGNUPS !== 'open') {
      // Invite-gated sign-up: claim the invite for this one new account,
      // atomically, so one invite can create at most one account.
      // The invite presented when the link was asked for; else (older
      // links) the one this device sends.
      const invite = row.invite_hash ?? (input.invite ? await hashToken(input.invite) : null);
      if (!invite)
        throw new HttpError(
          403,
          'signups_closed',
          'New accounts need an invite from your partner right now. Open their invite link, then ask for a new sign-in link.',
        );
      const claimed = await env.DB.prepare(
        `UPDATE invites SET claimed_by = ?1
          WHERE id = ?2 AND kind = 'partner' AND used_at IS NULL AND expires_at > ?3 AND claimed_by IS NULL
          RETURNING id`,
      )
        .bind(id, invite, Date.now())
        .first();
      if (!claimed)
        throw new HttpError(
          403,
          'signups_closed',
          'New accounts need an invite from your partner right now. Open their invite link, then ask for a new sign-in link.',
        );
    }
    user = { id, email: row.email };
    await env.DB.prepare(
      'INSERT INTO users (id, email, created_at, last_active) VALUES (?, ?, ?, ?)',
    )
      .bind(user.id, user.email, Date.now(), Date.now())
      .run();
    created = true;
  }
  const session = await createSession(env, user.id, input.device_label);
  return { ...session, user, new_user: created };
}

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
    v.object({
      challenge_id: v.string(),
      response: v.looseObject({ id: v.string() }),
      // Whether the passkey's app said it can give an unlock secret (PRF):
      // only shown to the person, so they know which passkeys can unlock.
      prf_enabled: v.optional(v.boolean()),
    }),
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
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at, aaguid, prf)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      cred.id,
      c.var.user.id,
      cred.publicKey,
      cred.counter,
      cred.transports ? JSON.stringify(cred.transports) : null,
      Date.now(),
      verification.registrationInfo.aaguid ?? null,
      input.prf_enabled === undefined ? null : input.prf_enabled ? 1 : 0,
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
    `SELECT p.id, p.created_at, p.aaguid, p.prf,
            p.created_at > COALESCE(u.keys_changed_at, 0) AS can_unlock
       FROM passkeys p JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ? ORDER BY p.created_at`,
  )
    .bind(c.var.user.id)
    .all<{
      id: string;
      created_at: number;
      aaguid: string | null;
      prf: number | null;
      can_unlock: number;
    }>();
  // prf: whether its app said it can unlock keys when it was added (null: didn't say).
  return c.json({
    passkeys: rows.results.map((r) => ({
      ...r,
      prf: r.prf === null ? null : !!r.prf,
      can_unlock: !!r.can_unlock,
    })),
  });
});

auth.delete('/passkeys/:id', requireAuth, async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), c.var.user.id)
    .run();
  if (!result.meta.changes) throw new HttpError(404, 'not_found');
  return c.json({ ok: true });
});
