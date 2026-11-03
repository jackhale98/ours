// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Outgoing email (magic links). Provider is configurable; the owner has not
 * chosen one yet (open question 3), so 'log' (send nothing) is the default and
 * Resend is implemented as a first option. Never logs addresses or links.
 */
import type { Env } from '../env';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export type Sender = (env: Env, email: Email) => Promise<void>;

let override: Sender | null = null;

/** Tests capture outgoing mail instead of sending it. */
export function setSender(sender: Sender | null): void {
  override = sender;
}

export async function sendEmail(env: Env, email: Email): Promise<void> {
  if (override) return override(env, email);
  if (env.EMAIL_PROVIDER === 'resend') {
    if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) throw new Error('email_not_configured');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [email.to],
        subject: email.subject,
        text: email.text,
      }),
    });
    if (!res.ok) throw new Error(`email_failed_${res.status}`);
  }
  // 'log' / unset: deliberately send nothing (and log nothing about the recipient).
}
