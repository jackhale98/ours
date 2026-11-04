// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKey, KeyRing, keyId } from '@ours/core/crypto';
import { describe, expect, it } from 'vitest';
import {
  activeRing,
  dropUnconfirmed,
  KeyLinkError,
  mergeFloor,
  refusal,
  stagedAction,
  stagedOutcome,
  takeKeys,
} from './rotation';

const SPACE = 'space-1';
const USER = 'user-1';

function ringWith(space: number[], personal: number[]) {
  const r = new KeyRing(USER);
  const keys = new Map<string, Uint8Array>();
  for (const v of space) {
    const key = generateKey();
    keys.set(`s${v}`, key);
    r.addSpaceKey(SPACE, { version: v, key });
  }
  for (const v of personal) {
    const key = generateKey();
    keys.set(`p${v}`, key);
    r.addPersonalKey({ version: v, key });
  }
  return { r, keys };
}
const sk = (version: number, key: Uint8Array) => ({
  version,
  kid: keyId('space', SPACE, version, key),
});
const pk = (version: number, key: Uint8Array) => ({
  version,
  kid: keyId('user', USER, version, key),
});

describe('floor (review 0005, M6)', () => {
  it('never goes down, and pins the rotation point of a version', () => {
    let f = mergeFloor(undefined, { space: 2, personal: 1, rotatedRev: 40 });
    f = mergeFloor(f, { space: 1, personal: 1, rotatedRev: 0 });
    expect(f).toEqual({ space: 2, personal: 1, rotatedRev: 40 });
    // Same version, a later rotation point claimed: ignored.
    f = mergeFloor(f, { space: 2, personal: 2, rotatedRev: 900 });
    expect(f).toEqual({ space: 2, personal: 2, rotatedRev: 40 });
    // A real new rotation moves it.
    f = mergeFloor(f, { space: 3, personal: 2, rotatedRev: 70 });
    expect(f).toEqual({ space: 3, personal: 2, rotatedRev: 70 });
  });
});

describe('real keys only (review 0005, H1)', () => {
  it('drops keys above the floor: a rotation that never happened', () => {
    const { r } = ringWith([1, 2], [1, 2]);
    expect(dropUnconfirmed(r, SPACE, { space: 1, personal: 1, rotatedRev: 0 })).toBe(2);
    expect(r.currentSpaceKey(SPACE).version).toBe(1);
    expect(r.currentPersonalKey().version).toBe(1);
  });

  it('sets aside a key whose fingerprint differs, and says the current one is wrong', () => {
    const { r, keys } = ringWith([1, 2], [1]);
    const floor = { space: 2, personal: 1, rotatedRev: 10 };
    const real = generateKey();
    const a = activeRing(r, SPACE, floor, { space: [sk(2, real)], personal: [] });
    expect(a.space).toBe('mismatch');
    expect(a.personal).toBe('ok');
    // Never sealed under: the active ring's newest space key is the old one.
    expect(a.ring.currentSpaceKey(SPACE).version).toBe(1);
    // The right one is fine.
    const b = activeRing(r, SPACE, floor, {
      space: [sk(2, keys.get('s2') as Uint8Array)],
      personal: [],
    });
    expect(b.space).toBe('ok');
    expect(activeRing(r, SPACE, { ...floor, space: 3 }, { space: [], personal: [] }).space).toBe(
      'missing',
    );
  });
});

describe('keys from a link (review 0005, H1 and M4)', () => {
  const floor = { space: 2, personal: 1, rotatedRev: 10 };

  it('takes the current version when this device needs it and the fingerprint matches', () => {
    const { r, keys } = ringWith([1], [1]);
    const v2 = generateKey();
    const { next } = takeKeys(
      r,
      SPACE,
      floor,
      { space: [sk(2, v2)], personal: [] },
      {
        space: [
          { version: 1, key: keys.get('s1') as Uint8Array },
          { version: 2, key: v2 },
        ],
      },
    );
    expect(next.currentSpaceKey(SPACE).version).toBe(2);
    // The original ring is untouched until the caller saves.
    expect(r.currentSpaceKey(SPACE).version).toBe(1);
  });

  it('refuses keys the server doesn’t know: a removed device’s own keys', () => {
    const { r, keys } = ringWith([1], [1]);
    const kids = { space: [sk(2, generateKey())], personal: [] };
    expect(() =>
      takeKeys(r, SPACE, floor, kids, {
        space: [
          { version: 1, key: keys.get('s1') as Uint8Array },
          { version: 2, key: generateKey() },
        ],
      }),
    ).toThrow(KeyLinkError);
  });

  it('refuses a link above or below the current version, or when nothing is needed', () => {
    const { r, keys } = ringWith([1, 2], [1]);
    const s2 = keys.get('s2') as Uint8Array;
    const kids = { space: [sk(2, s2)], personal: [] };
    expect(() =>
      takeKeys(r, SPACE, floor, kids, { space: [{ version: 3, key: generateKey() }] }),
    ).toThrow(/current keys/);
    expect(() =>
      takeKeys(r, SPACE, { ...floor, space: 3 }, kids, { space: [{ version: 2, key: s2 }] }),
    ).toThrow(/current keys/);
    expect(() => takeKeys(r, SPACE, floor, kids, { space: [{ version: 2, key: s2 }] })).toThrow(
      /already has/,
    );
  });

  it('refuses a conflicting key for a version this device holds (no silent skip)', () => {
    const { r } = ringWith([1], [1]);
    // No fingerprint for v1 on the server (made before fingerprints existed).
    const v2 = generateKey();
    expect(() =>
      takeKeys(
        r,
        SPACE,
        floor,
        { space: [sk(2, v2)], personal: [] },
        {
          space: [
            { version: 1, key: generateKey() },
            { version: 2, key: v2 },
          ],
        },
      ),
    ).toThrow(/conflict/);
  });

  it('replaces this device’s orphan key when the link’s matches the server', () => {
    // An earlier rotation that failed left an orphan v2 here; the partner's
    // real v2 then arrives.
    const { r, keys } = ringWith([1, 2], [1]);
    const real = generateKey();
    const { next, setAside } = takeKeys(
      r,
      SPACE,
      floor,
      { space: [sk(2, real)], personal: [] },
      {
        space: [
          { version: 1, key: keys.get('s1') as Uint8Array },
          { version: 2, key: real },
        ],
      },
    );
    expect(next.spaceKey(SPACE, 2)).toEqual(real);
    // The replaced key is kept aside, not lost, in case the server lied (N5).
    expect(setAside).toEqual([{ scope: 'space', version: 2, key: keys.get('s2') }]);
  });

  it('takes personal keys from a device link, checked the same way', () => {
    const { r, keys } = ringWith([1], [1]);
    const s2 = generateKey();
    const p2 = generateKey();
    const kids = { space: [sk(2, s2)], personal: [pk(2, p2)] };
    const f = { space: 2, personal: 2, rotatedRev: 10 };
    const { next } = takeKeys(r, SPACE, f, kids, {
      space: [{ version: 2, key: s2 }],
      personal: [
        { version: 1, key: keys.get('p1') as Uint8Array },
        { version: 2, key: p2 },
      ],
    });
    expect(next.currentPersonalKey().version).toBe(2);
    expect(() =>
      takeKeys(r, SPACE, f, kids, {
        space: [{ version: 2, key: s2 }],
        personal: [{ version: 2, key: generateKey() }],
      }),
    ).toThrow(KeyLinkError);
  });
});

describe('a rotation whose answer was lost (re-review N1)', () => {
  const st = { spaceFrom: 1, personalFrom: 1 };
  const staged = () => {
    const r = new KeyRing(USER);
    const s2 = generateKey();
    const p2 = generateKey();
    r.addSpaceKey(SPACE, { version: 2, key: s2 });
    r.addPersonalKey({ version: 2, key: p2 });
    return { r, s2, p2 };
  };

  it('counts as landed when the server holds these keys’ fingerprints', () => {
    const { r, s2, p2 } = staged();
    expect(
      stagedOutcome(r, SPACE, st, {
        space: 2,
        personal: 2,
        spaceKids: [sk(2, s2)],
        personalKids: [pk(2, p2)],
      }),
    ).toBe('landed');
  });

  it('can be sent again while the versions haven’t moved', () => {
    const { r } = staged();
    expect(
      stagedOutcome(r, SPACE, st, { space: 1, personal: 1, spaceKids: [], personalKids: [] }),
    ).toBe('retry');
  });

  it('is dead when someone else’s rotation came first', () => {
    const { r } = staged();
    expect(
      stagedOutcome(r, SPACE, st, {
        space: 2,
        personal: 1,
        spaceKids: [sk(2, generateKey())],
        personalKids: [],
      }),
    ).toBe('drop');
  });
});

describe('staged keys after a refresh or a refusal (re-review 2)', () => {
  it('commits what landed, even on a cached answer', () => {
    expect(stagedAction({ backup: true }, 'landed', false)).toBe('commit');
  });

  it('never drops on a cached answer (R1)', () => {
    expect(stagedAction({ backup: true }, 'drop', false)).toBe('keep');
    expect(stagedAction({ backup: false }, 'retry', false)).toBe('keep');
  });

  it('drops when another rotation won, or the backup was never confirmed (R3)', () => {
    expect(stagedAction({ backup: true }, 'drop', true)).toBe('drop');
    expect(stagedAction({ backup: false }, 'retry', true)).toBe('drop');
    expect(stagedAction({ backup: true }, 'retry', true)).toBe('keep');
  });

  it('keeps the keys when a passkey check is needed or the feature is off (R2)', () => {
    expect(refusal('rotation_conflict')).toBe('check');
    expect(refusal('multi_space')).toBe('drop');
    expect(refusal('reauth_required')).toBe('keep');
    expect(refusal('rotation_off')).toBe('keep');
  });
});
