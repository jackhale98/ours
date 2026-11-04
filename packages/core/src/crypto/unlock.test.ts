// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { randomBytes, toBase64Url } from './bytes';
import { generateKey, KeyRing } from './keys';
import { openUnlock, sealUnlock, UNLOCK_SALT } from './unlock';

const ring = () => {
  const r = new KeyRing('user-1');
  r.addPersonalKey({ version: 1, key: generateKey() });
  r.addSpaceKey('space-1', { version: 1, key: generateKey() });
  return r;
};

describe('passkey unlock (ADR 0015)', () => {
  it('opens with the same passkey output, user and credential', () => {
    const r = ring();
    const prf = randomBytes(32);
    const sealed = sealUnlock(prf, r, 'cred-1');
    const back = openUnlock(prf, 'user-1', 'cred-1', sealed);
    expect(back.currentPersonalKey()).toEqual(r.currentPersonalKey());
    expect(back.currentSpaceKey('space-1')).toEqual(r.currentSpaceKey('space-1'));
  });

  it('refuses another output, user or credential', () => {
    const r = ring();
    const prf = randomBytes(32);
    const sealed = sealUnlock(prf, r, 'cred-1');
    expect(() => openUnlock(randomBytes(32), 'user-1', 'cred-1', sealed)).toThrow();
    expect(() => openUnlock(prf, 'user-2', 'cred-1', sealed)).toThrow();
    expect(() => openUnlock(prf, 'user-1', 'cred-2', sealed)).toThrow();
    expect(() => sealUnlock(randomBytes(16), r, 'cred-1')).toThrow();
  });

  it('asks every passkey the same fixed question', () => {
    expect(UNLOCK_SALT).toHaveLength(32);
    expect(toBase64Url(UNLOCK_SALT)).toMatchInlineSnapshot(
      `"xpS27J_I1bZ00JD__GUH1gtLxbNg1M55gSOstgRw8k4"`,
    );
  });
});
