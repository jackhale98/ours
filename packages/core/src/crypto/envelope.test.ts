// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CryptoError, utf8 } from './bytes';
import {
  decryptRecord,
  encryptRecord,
  keyForHeader,
  openRecord,
  type RecordHeader,
  recordAad,
  sealRecord,
} from './envelope';
import { generateKey, KeyRing } from './keys';

const SPACE = 'space-1';

function ringFor(user: string, spaceKey = generateKey()): KeyRing {
  const ring = new KeyRing(user);
  ring.addPersonalKey({ version: 1, key: generateKey() });
  ring.addSpaceKey(SPACE, { version: 1, key: spaceKey });
  return ring;
}

const header: RecordHeader = {
  id: 'rec-1',
  space_id: SPACE,
  scope: 'space',
  owner_user_id: null,
  key_version: 1,
  deleted: false,
};

describe('record envelope', () => {
  it('round-trips a space record between partners', () => {
    const sk = generateKey();
    const sam = ringFor('sam', sk);
    const alex = ringFor('alex', sk);
    const sealed = sealRecord(
      sam,
      { id: 'r1', space_id: SPACE, scope: 'space', deleted: false },
      utf8('hello'),
    );
    expect(sealed.header).toEqual({
      id: 'r1',
      space_id: SPACE,
      scope: 'space',
      owner_user_id: null,
      key_version: 1,
      deleted: false,
    });
    expect(openRecord(alex, sealed.header, sealed)).toEqual(utf8('hello'));
  });

  it('keeps user records readable only by their owner', () => {
    const sk = generateKey();
    const sam = ringFor('sam', sk);
    const alex = ringFor('alex', sk);
    const sealed = sealRecord(
      sam,
      { id: 'r2', space_id: SPACE, scope: 'user', deleted: false },
      utf8('private'),
    );
    expect(sealed.header.owner_user_id).toBe('sam');
    expect(openRecord(sam, sealed.header, sealed)).toEqual(utf8('private'));
    expect(() => openRecord(alex, sealed.header, sealed)).toThrow(
      expect.objectContaining({ code: 'key' }),
    );
    // Even if the server relabels the owner, Alex's personal key cannot open it.
    const relabelled = { ...sealed.header, owner_user_id: 'alex' };
    expect(() => openRecord(alex, relabelled, sealed)).toThrow(CryptoError);
  });

  it('uses the newest key version for writes and old versions for reads', () => {
    const ring = ringFor('sam');
    const old = sealRecord(
      ring,
      { id: 'r3', space_id: SPACE, scope: 'space', deleted: false },
      utf8('v1'),
    );
    ring.addSpaceKey(SPACE, { version: 2, key: generateKey() });
    const fresh = sealRecord(
      ring,
      { id: 'r4', space_id: SPACE, scope: 'space', deleted: false },
      utf8('v2'),
    );
    expect(fresh.header.key_version).toBe(2);
    expect(openRecord(ring, old.header, old)).toEqual(utf8('v1'));
    expect(openRecord(ring, fresh.header, fresh)).toEqual(utf8('v2'));
  });

  it('fails for an unknown key version', () => {
    const ring = ringFor('sam');
    expect(() => keyForHeader(ring, { ...header, key_version: 9 })).toThrow(
      expect.objectContaining({ code: 'unknown-key-version' }),
    );
    expect(() => keyForHeader(ring, { ...header, space_id: 'other' })).toThrow(
      expect.objectContaining({ code: 'unknown-key-version' }),
    );
  });

  describe('AAD binding (server tampering)', () => {
    const key = generateKey();
    const sealed = encryptRecord(key, header, utf8('content'));
    const variants: [string, RecordHeader][] = [
      ['record id (swap between records)', { ...header, id: 'rec-2' }],
      ['space id (swap between spaces)', { ...header, space_id: 'space-2' }],
      ['scope', { ...header, scope: 'user', owner_user_id: 'sam' }],
      ['key version', { ...header, key_version: 2 }],
    ];
    it.each(variants)('rejects a changed %s', (_name, changed) => {
      expect(() => decryptRecord(key, changed, sealed)).toThrow(
        expect.objectContaining({ code: 'decrypt' }),
      );
    });

    it('rejects a changed owner on user records', () => {
      const userHeader: RecordHeader = { ...header, scope: 'user', owner_user_id: 'sam' };
      const s = encryptRecord(key, userHeader, utf8('x'));
      expect(() => decryptRecord(key, { ...userHeader, owner_user_id: 'alex' }, s)).toThrow(
        CryptoError,
      );
    });

    it('rejects ciphertext replayed onto another record', () => {
      const other = encryptRecord(key, { ...header, id: 'rec-9' }, utf8('other'));
      expect(() => decryptRecord(key, header, other)).toThrow(CryptoError);
    });
  });

  describe('header validation', () => {
    it.each<[string, Partial<RecordHeader>]>([
      ['empty id', { id: '' }],
      ['empty space', { space_id: '' }],
      ['huge id', { id: 'x'.repeat(200) }],
      ['space record with owner', { owner_user_id: 'sam' }],
      ['user record without owner', { scope: 'user', owner_user_id: null }],
      ['bad scope', { scope: 'public' as never }],
      ['zero key version', { key_version: 0 }],
      ['fractional key version', { key_version: 1.5 }],
    ])('rejects %s', (_name, patch) => {
      expect(() => recordAad({ ...header, ...patch })).toThrow(
        expect.objectContaining({ code: 'format' }),
      );
    });
  });
});

describe('KeyRing', () => {
  it('reports missing keys', () => {
    const ring = new KeyRing('u');
    expect(() => ring.currentPersonalKey()).toThrow(CryptoError);
    expect(() => ring.currentSpaceKey('s')).toThrow(CryptoError);
    expect(() => ring.personalKey(1)).toThrow(CryptoError);
    expect(ring.spaceKeys('s')).toEqual([]);
  });

  it('validates keys and versions', () => {
    const ring = new KeyRing('u');
    expect(() => ring.addPersonalKey({ version: 1, key: new Uint8Array(31) })).toThrow(CryptoError);
    expect(() => ring.addSpaceKey('s', { version: 1, key: new Uint8Array(33) })).toThrow(
      CryptoError,
    );
    expect(() => ring.addSpaceKey('s', { version: 0, key: generateKey() })).toThrow(CryptoError);
  });

  it('removes a space', () => {
    const ring = new KeyRing('u');
    ring.addSpaceKey('s', { version: 1, key: generateKey() });
    expect(ring.spaceIds()).toEqual(['s']);
    ring.removeSpace('s');
    expect(ring.spaceIds()).toEqual([]);
  });

  it('sorts key versions', () => {
    const ring = new KeyRing('u');
    ring.addSpaceKey('s', { version: 3, key: generateKey() });
    ring.addSpaceKey('s', { version: 1, key: generateKey() });
    expect(ring.spaceKeys('s').map((k) => k.version)).toEqual([1, 3]);
    expect(ring.currentSpaceKey('s').version).toBe(3);
  });
});
