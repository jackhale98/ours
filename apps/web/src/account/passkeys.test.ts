// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { providerName, unlockStatus, userVerified } from './passkeys';

describe('passkey unlock checks (review 0006)', () => {
  it('uses the unlock secret only when the person was verified (M2)', () => {
    const data = new Uint8Array(37);
    data[32] = 0x01; // user present only
    expect(userVerified(data)).toBe(false);
    data[32] = 0x05; // present and verified
    expect(userVerified(data)).toBe(true);
    expect(userVerified(new Uint8Array(10))).toBe(false);
  });

  it('names well-known passkey providers, and nothing else (M1)', () => {
    expect(providerName('fbfc3007-154e-4ecc-8c0b-6e020557d7bd')).toBe('iCloud Keychain');
    expect(providerName('EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4')).toBe('Google Password Manager');
    expect(providerName('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(providerName('12345678-1234-1234-1234-123456789012')).toBeNull();
    expect(providerName(null)).toBeNull();
  });

  it('tells which copies are current, behind, or set up elsewhere (M1, L4)', () => {
    const now = { space: 2, personal: 2 };
    const pk = { id: 'p1', can_unlock: true };
    const copy = (v: number, at = 100) => ({
      created_at: at,
      space_version: v,
      personal_version: v,
    });
    expect(unlockStatus(pk, undefined, now, {})).toBe('off');
    expect(unlockStatus({ ...pk, can_unlock: false }, undefined, now, {})).toBe('too-old');
    expect(unlockStatus(pk, copy(2), now, {})).toBe('current');
    // Behind, and this device made it: it can update it.
    expect(unlockStatus(pk, copy(1), now, { p1: 100 })).toBe('behind');
    // Behind, made somewhere else (e.g. a lost phone right after a rotation):
    // never offered for update here.
    expect(unlockStatus(pk, copy(1, 200), now, { p1: 100 })).toBe('behind-elsewhere');
    expect(unlockStatus(pk, copy(1), now, {})).toBe('behind-elsewhere');
  });
});
