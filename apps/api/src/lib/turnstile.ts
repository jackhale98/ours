// SPDX-License-Identifier: AGPL-3.0-or-later
/** Cloudflare Turnstile bot check for sign-up and magic-link requests. */
import type { Env } from '../env';
import { HttpError } from './http';

export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string | undefined,
): Promise<void> {
  if (!env.TURNSTILE_SECRET) return; // not configured (local dev, tests, some self-hosts)
  if (!token) throw new HttpError(403, 'bot_check_required');
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  if (!data.success) throw new HttpError(403, 'bot_check_failed');
}
