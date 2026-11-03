// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { inactiveAccounts } from '../src/lib/accounts';
import { call, couple, outbox, signIn, uniqueEmail } from './helpers';

const DAY = 86_400_000;
const exists = async (id: string) =>
  !!(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(id).first());
const age = (id: string, days: number) =>
  env.DB.prepare('UPDATE users SET last_active = ? WHERE id = ?')
    .bind(Date.now() - days * DAY, id)
    .run();

describe('inactive accounts', () => {
  it('warns after a year, then deletes a month later', async () => {
    const email = uniqueEmail('idle');
    const u = await signIn(email);
    await age(u.userId, 370);
    const mails = outbox.length;
    await inactiveAccounts(env);
    expect(
      outbox.slice(mails).some((m) => m.to === email && /deleted in 30 days/.test(m.subject)),
    ).toBe(true);
    // Not yet: the grace period has not passed.
    await inactiveAccounts(env, Date.now() + 10 * DAY);
    expect(await exists(u.userId)).toBe(true);
    await inactiveAccounts(env, Date.now() + 31 * DAY);
    expect(await exists(u.userId)).toBe(false);
  });

  it('keeps anyone who comes back after the warning', async () => {
    const email = uniqueEmail('back');
    const u = await signIn(email);
    await age(u.userId, 370);
    await inactiveAccounts(env);
    // They sign in again.
    await signIn(email);
    await inactiveAccounts(env, Date.now() + 31 * DAY);
    expect(await exists(u.userId)).toBe(true);
    const row = await env.DB.prepare('SELECT inactive_warned_at FROM users WHERE id = ?')
      .bind(u.userId)
      .first<{ inactive_warned_at: number | null }>();
    expect(row?.inactive_warned_at).toBeNull();
  });

  it('leaves active people alone, and the partner keeps shared plans', async () => {
    const { sam, alex, spaceId } = await couple();
    await age(sam.userId, 370);
    await inactiveAccounts(env);
    await inactiveAccounts(env, Date.now() + 31 * DAY);
    expect(await exists(sam.userId)).toBe(false);
    expect(await exists(alex.userId)).toBe(true);
    const me = await call('/me', { token: alex.token });
    expect(me.json.spaces.map((s: { space_id: string }) => s.space_id)).toContain(spaceId);
  });
});
