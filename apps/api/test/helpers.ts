// SPDX-License-Identifier: AGPL-3.0-or-later

import { exports } from 'cloudflare:workers';
import { uuidv7 } from '@ours/core/schema';
import { type Email, setSender } from '../src/lib/email';

export const ORIGIN = 'https://app.example';
export const outbox: Email[] = [];
setSender(async (_env, email) => {
  outbox.push(email);
});

/** Emails are sent after the response (no timing leak), so wait briefly for one to arrive. */
export async function nextMail(index: number, timeoutMs = 500): Promise<Email | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (outbox[index]) return outbox[index];
    await new Promise((r) => setTimeout(r, 5));
  }
  return outbox[index];
}

let ipCounter = 0;
/** A fresh client IP per call keeps per-IP rate limits out of unrelated tests. */
export const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

export async function call(
  path: string,
  init: {
    method?: string;
    token?: string;
    body?: unknown;
    ip?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    'CF-Connecting-IP': init.ip ?? freshIp(),
    ...init.headers,
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await exports.default.fetch(
    new Request(`https://api.example${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  // biome-ignore lint/suspicious/noExplicitAny: test convenience
  return { status: res.status, json: json as any, headers: res.headers };
}

/** Signs up (or in) by magic link; returns the session token and user id. */
export async function signIn(email: string, opts: { invite?: string; acceptTerms?: boolean } = {}) {
  const before = outbox.length;
  const start = await call('/auth/email/start', {
    body: {
      email,
      accept_terms: opts.acceptTerms ?? true,
      ...(opts.invite ? { invite: opts.invite } : {}),
    },
  });
  if (start.status !== 200) throw new Error(`start ${start.status}`);
  // The sign-in email to this address: other tests' notices may arrive meanwhile.
  let token: string | undefined;
  const deadline = Date.now() + 500;
  for (let i = before; !token && Date.now() < deadline; ) {
    const mail = await nextMail(i, deadline - Date.now());
    if (!mail) break;
    if (mail.to === email.trim().toLowerCase())
      token = /#signin=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
    i++;
  }
  if (!token) throw new Error('no email sent');
  const verify = await call('/auth/email/verify', {
    body: { token, device_label: 'Test', ...(opts.invite ? { invite: opts.invite } : {}) },
  });
  if (verify.status !== 200)
    throw new Error(`verify ${verify.status} ${JSON.stringify(verify.json)}`);
  return {
    token: verify.json.token as string,
    userId: verify.json.user.id as string,
    deviceId: verify.json.device_id as string,
    email,
  };
}

export const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
export const randomB64 = (n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536)
    crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65_536)));
  let bin = '';
  for (const byte of out) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function envelope(
  spaceId: string,
  opts: { id?: string; scope?: 'space' | 'user'; owner?: string; size?: number } = {},
) {
  return {
    id: opts.id ?? uuidv7(),
    space_id: spaceId,
    scope: opts.scope ?? 'space',
    owner_user_id: opts.scope === 'user' ? (opts.owner ?? null) : null,
    key_version: 1,
    nonce: randomB64(24),
    ciphertext: randomB64(opts.size ?? 96),
    deleted: false,
  };
}

let n = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}${++n}-${Date.now()}@example.com`;

/** Two partners sharing one space. */
export async function couple() {
  const sam = await signIn(uniqueEmail('sam'));
  const alex = await signIn(uniqueEmail('alex'));
  const space = await call('/spaces', { token: sam.token, body: {} });
  const spaceId = space.json.id as string;
  const inv = await call('/invites', {
    token: sam.token,
    body: {
      kind: 'partner',
      space_id: spaceId,
      wrapped: { nonce: randomB64(24), ciphertext: randomB64(120) },
    },
  });
  await call(`/invites/${inv.json.id}`, { token: alex.token });
  await call(`/invites/${inv.json.id}/accept`, { token: alex.token, body: {} });
  return { sam, alex, spaceId };
}
