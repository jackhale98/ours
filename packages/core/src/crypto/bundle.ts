// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Serialisation of key material for wrapping (backups, device linking,
 * partner invites). Parsing is strict: anything unexpected is rejected.
 */
import * as v from 'valibot';
import { KEY_LENGTH } from './aead';
import { CryptoError, fromBase64Url, fromUtf8, toBase64Url, utf8 } from './bytes';
import { KeyRing, type VersionedKey } from './keys';

const Id = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const KeyB64 = v.pipe(v.string(), v.length(43)); // 32 bytes, base64url, no padding
const Version = v.pipe(v.number(), v.integer(), v.minValue(1));
const WireKey = v.strictObject({ version: Version, key: KeyB64 });
const WireKeys = v.pipe(v.array(WireKey), v.minLength(1), v.maxLength(1000));

const WireBundle = v.strictObject({
  v: v.literal(1),
  user_id: Id,
  personal: WireKeys,
  spaces: v.pipe(v.array(v.strictObject({ space_id: Id, keys: WireKeys })), v.maxLength(100)),
});

const WireSpaceKeys = v.strictObject({
  v: v.literal(1),
  space_id: Id,
  keys: WireKeys,
  inviter_name: v.optional(v.pipe(v.string(), v.maxLength(80))),
});

function encodeKeys(keys: VersionedKey[]) {
  return keys.map(({ version, key }) => ({ version, key: toBase64Url(key) }));
}

function decodeKeys(keys: { version: number; key: string }[]): VersionedKey[] {
  const seen = new Set<number>();
  return keys.map(({ version, key }) => {
    if (seen.has(version)) throw new CryptoError('format', 'Duplicate key version');
    seen.add(version);
    const bytes = fromBase64Url(key);
    if (bytes.length !== KEY_LENGTH) throw new CryptoError('format', 'Bad key length');
    return { version, key: bytes };
  });
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(fromUtf8(bytes));
  } catch {
    throw new CryptoError('format', 'Malformed key payload');
  }
}

/** Every key a user holds: personal keys plus all versions of every space key. */
export function serializeKeyRing(ring: KeyRing): Uint8Array {
  return utf8(
    JSON.stringify({
      v: 1,
      user_id: ring.userId,
      personal: encodeKeys(ring.personalKeys()),
      spaces: ring.spaceIds().map((space_id) => ({
        space_id,
        keys: encodeKeys(ring.spaceKeys(space_id)),
      })),
    }),
  );
}

export function parseKeyRing(bytes: Uint8Array): KeyRing {
  const result = v.safeParse(WireBundle, parseJson(bytes));
  if (!result.success) throw new CryptoError('format', 'Invalid key bundle');
  const ring = new KeyRing(result.output.user_id);
  for (const k of decodeKeys(result.output.personal)) ring.addPersonalKey(k);
  const spaceIds = new Set<string>();
  for (const s of result.output.spaces) {
    if (spaceIds.has(s.space_id)) throw new CryptoError('format', 'Duplicate space');
    spaceIds.add(s.space_id);
    for (const k of decodeKeys(s.keys)) ring.addSpaceKey(s.space_id, k);
  }
  return ring;
}

export interface SpaceKeyPayload {
  space_id: string;
  keys: VersionedKey[];
  inviter_name?: string;
}

/** What a partner invite carries: every version of one space key. */
export function serializeSpaceKeys(payload: SpaceKeyPayload): Uint8Array {
  return utf8(
    JSON.stringify({
      v: 1,
      space_id: payload.space_id,
      keys: encodeKeys(payload.keys),
      ...(payload.inviter_name === undefined ? {} : { inviter_name: payload.inviter_name }),
    }),
  );
}

export function parseSpaceKeys(bytes: Uint8Array): SpaceKeyPayload {
  const result = v.safeParse(WireSpaceKeys, parseJson(bytes));
  if (!result.success) throw new CryptoError('format', 'Invalid space key payload');
  const { space_id, keys, inviter_name } = result.output;
  return {
    space_id,
    keys: decodeKeys(keys),
    ...(inviter_name === undefined ? {} : { inviter_name }),
  };
}
