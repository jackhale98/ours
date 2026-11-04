// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Key rotation checks that don't need the network (ADR 0013, review 0005).
 * Kept apart from session.ts so they can be tested on their own.
 *
 * - Floors only go up, and the rotation point for a version is pinned the
 *   first time this device learns it (M6): a server can't move either later.
 * - Only keys that are real are used. A key above the floor never became
 *   current (a rotation that didn't happen) and is dropped; a key whose
 *   fingerprint differs from the server's is set aside for this session
 *   (H1). Nothing is sealed under either.
 * - Keys from a link are taken only when this device needs them, only for
 *   the current version, and only if every fingerprint matches (H1, M4).
 */
import { CryptoError, KeyRing, keyId, parseKeyRing, serializeKeyRing } from '@ours/core/crypto';

export interface Kid {
  version: number;
  kid: string;
}

/** The versions this device must write under, and the rotation point it trusts. */
export interface Floor {
  space: number;
  personal: number;
  /**
   * The space's revision when it moved to `space`, pinned the first time
   * this device learns that version (from its own rotation, or from /me).
   */
  rotatedRev: number;
}

/** Merges what the server says into what this device already knows; never goes down. */
export function mergeFloor(
  prev: Floor | undefined,
  server: { space: number; personal: number; rotatedRev: number },
): Floor {
  if (!prev)
    return { space: server.space, personal: server.personal, rotatedRev: server.rotatedRev };
  return {
    space: Math.max(prev.space, server.space),
    personal: Math.max(prev.personal, server.personal),
    rotatedRev: server.space > prev.space ? server.rotatedRev : prev.rotatedRev,
  };
}

export const copyRing = (r: KeyRing) => parseKeyRing(serializeKeyRing(r));

const kidOf = (kids: readonly Kid[], version: number) =>
  kids.find((k) => k.version === version)?.kid;

/**
 * Keys above the floor never became current: a rotation that failed, or one
 * kept in a backup made just before it (H1, H2). Returns how many went.
 */
export function dropUnconfirmed(ring: KeyRing, spaceId: string, floor: Floor): number {
  let n = 0;
  for (const k of ring.spaceKeys(spaceId))
    if (k.version > floor.space) {
      ring.dropSpaceKey(spaceId, k.version);
      n++;
    }
  for (const k of ring.personalKeys())
    if (k.version > floor.personal) {
      ring.dropPersonalKey(k.version);
      n++;
    }
  return n;
}

export type KeyState = 'ok' | 'missing' | 'mismatch';

/**
 * The ring this device uses now: without keys whose fingerprint differs from
 * the server's (kept on disk, but never used to seal or open), and whether it
 * holds the current space and personal keys.
 */
export function activeRing(
  ring: KeyRing,
  spaceId: string,
  floor: Floor,
  kids: { space: readonly Kid[]; personal: readonly Kid[] },
): { ring: KeyRing; space: KeyState; personal: KeyState } {
  const active = copyRing(ring);
  let space: KeyState = 'missing';
  let personal: KeyState = 'missing';
  for (const k of active.spaceKeys(spaceId)) {
    const want = kidOf(kids.space, k.version);
    const ok = !want || keyId('space', spaceId, k.version, k.key) === want;
    if (!ok) active.dropSpaceKey(spaceId, k.version);
    if (k.version === floor.space) space = ok ? 'ok' : 'mismatch';
  }
  for (const k of active.personalKeys()) {
    const want = kidOf(kids.personal, k.version);
    const ok = !want || keyId('user', ring.userId, k.version, k.key) === want;
    if (!ok) active.dropPersonalKey(k.version);
    if (k.version === floor.personal) personal = ok ? 'ok' : 'mismatch';
  }
  return { ring: active, space, personal };
}

export class KeyLinkError extends Error {}

/**
 * Takes keys from a link into a copy of the ring, or refuses (H1, M4):
 * - the link must carry the current version, and this device must need it;
 * - every key whose version has a fingerprint on the server must match it;
 * - a key this device already holds for a version must be the same, unless
 *   this device's copy is the one that doesn't match (then it's replaced).
 */
export function takeKeys(
  ring: KeyRing,
  spaceId: string,
  floor: Floor,
  kids: { space: readonly Kid[]; personal: readonly Kid[] },
  incoming: {
    space: readonly { version: number; key: Uint8Array }[];
    personal?: readonly { version: number; key: Uint8Array }[];
  },
): KeyRing {
  const now = activeRing(ring, spaceId, floor, kids);
  const newest = Math.max(0, ...incoming.space.map((k) => k.version));
  if (newest !== floor.space)
    throw new KeyLinkError('That link isn’t for the current keys. Ask for a new one.');
  const needed = now.space !== 'ok' || (incoming.personal !== undefined && now.personal !== 'ok');
  if (!needed) throw new KeyLinkError('This device already has the current keys.');
  const next = copyRing(ring);
  const take = (
    scope: 'space' | 'user',
    owner: string,
    keys: readonly { version: number; key: Uint8Array }[],
    want: readonly Kid[],
    held: { version: number; key: Uint8Array }[],
    drop: (v: number) => void,
    add: (k: { version: number; key: Uint8Array }) => void,
  ) => {
    for (const k of keys) {
      if (k.version > (scope === 'space' ? floor.space : floor.personal)) continue;
      const fp = kidOf(want, k.version);
      if (fp && keyId(scope, owner, k.version, k.key) !== fp)
        throw new KeyLinkError(
          'The keys in that link don’t match your space. Don’t use it, and check your safety codes in person.',
        );
      const mine = held.find((h) => h.version === k.version);
      if (mine && !sameKey(mine.key, k.key)) {
        // Mine is the impostor only if the server's fingerprint says so.
        if (fp && keyId(scope, owner, mine.version, mine.key) !== fp) drop(k.version);
        else
          throw new KeyLinkError(
            'That link’s keys conflict with the ones on this device. Don’t use it.',
          );
      }
      try {
        add(k);
      } catch (err) {
        if (err instanceof CryptoError) throw new KeyLinkError('That link’s keys conflict.');
        throw err;
      }
    }
  };
  take(
    'space',
    spaceId,
    incoming.space,
    kids.space,
    next.spaceKeys(spaceId),
    (v) => next.dropSpaceKey(spaceId, v),
    (k) => next.addSpaceKey(spaceId, k),
  );
  if (incoming.personal)
    take(
      'user',
      ring.userId,
      incoming.personal,
      kids.personal,
      next.personalKeys(),
      (v) => next.dropPersonalKey(v),
      (k) => next.addPersonalKey(k),
    );
  return next;
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export { KeyRing };
