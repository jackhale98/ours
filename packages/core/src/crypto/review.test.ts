// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tests added after the independent crypto review (docs/reviews/0001-core-crypto.md):
 * frozen known-answer vectors, cross-context rejection with the same key,
 * key-version conflicts and scope policy.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import type { DecodedRecord, EventData } from '../schema/records';
import { buildAad } from './aad';
import { open, pad, seal } from './aead';
import { CryptoError, utf8 } from './bytes';
import { openDecodedRecord, scopeAllows, sealDecodedRecord } from './codec';
import { decryptRecord, encryptRecord, type RecordHeader, recordAad } from './envelope';
import { deriveKey, LABELS } from './kdf';
import { generateKey, KeyRing } from './keys';
import { openNotification, sealNotification } from './notify';
import {
  createDeviceInvite,
  createPartnerInvite,
  openDeviceInvite,
  openPartnerInvite,
} from './pairing';
import { openBackup, sealBackup } from './recovery';

const KEY = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const NONCE = hexToBytes('404142434445464748494a4b4c4d4e4f5051525354555657');
const header: RecordHeader = {
  id: '0190a6c8-7a3e-7cc2-9b1d-3f6e2a1b4c5d',
  space_id: 'space_1',
  scope: 'space',
  owner_user_id: null,
  key_version: 1,
  deleted: false,
};

describe('known-answer vectors (changing these breaks stored data)', () => {
  it('record AAD bytes', () => {
    expect(bytesToHex(recordAad(header))).toMatchInlineSnapshot(
      `"0000000e6f7572732f7265636f72642f76310000000773706163655f310000002430313930613663382d376133652d376363322d396231642d336636653261316234633564000000057370616365000000000000000131000000046c697665"`,
    );
  });

  it('record ciphertext for a fixed key, nonce and plaintext', () => {
    const ct = xchacha20poly1305(KEY, NONCE, recordAad(header)).encrypt(pad(utf8('hello')));
    expect(bytesToHex(ct)).toMatchInlineSnapshot(
      `"bc5c691cbf6079168ff487beaf9c659292baadc41359539a6a31fd450904239016f9026e55928410ffb2f44c0adadaf19b6b7de86f85b49cb6fc08f413b24c546a750af82a2ef2d441afea5d8f3f89b9"`,
    );
    expect(decryptRecord(KEY, header, { nonce: NONCE, ciphertext: ct })).toEqual(utf8('hello'));
  });

  it('invite and recovery key derivations', () => {
    expect(bytesToHex(deriveKey(KEY, LABELS.invite))).toMatchInlineSnapshot(
      `"5fdff7fd2b527cc3e4c6d69729d8ae5624771e822d2415358d724bcf07ba59ea"`,
    );
    expect(bytesToHex(buildAad([LABELS.notify, 's', 1]))).toMatchInlineSnapshot(
      `"0000000e6f7572732f6e6f746966792f763100000001730000000131"`,
    );
  });
});

describe('cross-context rejection with the same key', () => {
  it('a record ciphertext is not a notification, and vice versa', () => {
    const key = generateKey();
    const rec = encryptRecord(key, { ...header, space_id: 's' }, utf8('{}'));
    expect(() => openNotification(key, 's', 1, rec, 0, () => false)).toThrow(CryptoError);
    const n = sealNotification(key, 's', 1, { title: 't', body: 'b' }, 0);
    expect(() => decryptRecord(key, { ...header, space_id: 's' }, n)).toThrow(CryptoError);
  });

  it('a backup is not a device invite, and vice versa', () => {
    const ring = new KeyRing('u1');
    ring.addPersonalKey({ version: 1, key: generateKey() });
    const secret = generateKey();
    const asBackup = sealBackup(deriveKey(secret, LABELS.invite), ring, 1);
    expect(() => openDeviceInvite(secret, 'u1', asBackup)).toThrow(CryptoError);
    const invite = createDeviceInvite(ring);
    expect(() =>
      openBackup(deriveKey(invite.secret, LABELS.invite), 'u1', 1, invite.wrapped),
    ).toThrow(CryptoError);
  });

  it('a partner invite is not a device invite', () => {
    const { secret, wrapped } = createPartnerInvite({
      space_id: 'u1',
      keys: [{ version: 1, key: generateKey() }],
    });
    expect(() => openDeviceInvite(secret, 'u1', wrapped)).toThrow(CryptoError);
    expect(openPartnerInvite(secret, 'u1', wrapped).space_id).toBe('u1');
  });

  it('the server cannot flip the tombstone flag', () => {
    const key = generateKey();
    const sealed = encryptRecord(key, header, utf8('x'));
    expect(() => decryptRecord(key, { ...header, deleted: true }, sealed)).toThrow(CryptoError);
  });

  it('truncation fails tag verification, not just the length check', () => {
    const key = generateKey();
    const aad = utf8('a');
    const s = seal(key, new Uint8Array(100), aad);
    expect(s.ciphertext.length).toBe(128 + 16);
    expect(() => open(key, s.nonce, s.ciphertext.subarray(0, -1), aad)).toThrow(
      expect.objectContaining({ code: 'decrypt' }),
    );
  });

  it('rejects non-ASCII ids so AAD bytes stay unambiguous', () => {
    expect(() => recordAad({ ...header, id: '\uD800' })).toThrow(CryptoError);
    expect(() => recordAad({ ...header, space_id: 'café' })).toThrow(CryptoError);
  });
});

describe('key versions', () => {
  it('refuses a different key for an existing version', () => {
    const ring = new KeyRing('u');
    const k = generateKey();
    ring.addSpaceKey('s', { version: 2, key: k });
    ring.addSpaceKey('s', { version: 2, key: k.slice() });
    expect(() => ring.addSpaceKey('s', { version: 2, key: generateKey() })).toThrow(
      expect.objectContaining({ code: 'key' }),
    );
    ring.addPersonalKey({ version: 1, key: k });
    expect(() => ring.addPersonalKey({ version: 1, key: generateKey() })).toThrow(CryptoError);
  });

  it('merges rings without losing keys, and refuses conflicts or other users', () => {
    const a = new KeyRing('u');
    a.addPersonalKey({ version: 1, key: generateKey() });
    a.addSpaceKey('s', { version: 1, key: generateKey() });
    const b = new KeyRing('u');
    b.addPersonalKey({ version: 1, key: a.personalKey(1) });
    b.addSpaceKey('s', { version: 2, key: generateKey() });
    b.addSpaceKey('t', { version: 1, key: generateKey() });
    a.mergeFrom(b);
    expect(a.spaceKeys('s').map((k) => k.version)).toEqual([1, 2]);
    expect(a.spaceIds().sort()).toEqual(['s', 't']);
    const clash = new KeyRing('u');
    clash.addSpaceKey('s', { version: 1, key: generateKey() });
    expect(() => a.mergeFrom(clash)).toThrow(CryptoError);
    expect(() => a.mergeFrom(new KeyRing('other'))).toThrow(CryptoError);
  });
});

describe('scope policy', () => {
  const ring = new KeyRing('sam');
  ring.addPersonalKey({ version: 1, key: generateKey() });
  ring.addSpaceKey('s', { version: 1, key: generateKey() });
  const meta = { updated_at: 1, device_id: 'd' };
  const event: EventData = {
    title: 'Therapy',
    start: '2026-11-06T19:00',
    end: '2026-11-06T20:00',
    all_day: false,
    tz: 'UTC',
    rrule: null,
    owner: 'a',
    status: 'confirmed',
    proposed_by: null,
    privacy: 'busy',
    location: null,
    notes: null,
    countdown: false,
    away: false,
    stub_id: 'stub',
  };
  const busy: DecodedRecord = { kind: 'event', deleted: false, data: event, ...meta };
  const privateList: DecodedRecord = {
    kind: 'list',
    deleted: false,
    data: { name: 'Gifts', kind: 'ideas', private: true },
    ...meta,
  };
  const stub: DecodedRecord = {
    kind: 'busy_stub',
    deleted: false,
    data: {
      start: event.start,
      end: event.end,
      all_day: false,
      tz: 'UTC',
      rrule: null,
      away: false,
      owner: 'a',
    },
    ...meta,
  };
  const id = '0190a6c8-7a3e-7cc2-9b1d-3f6e2a1b4c5d';

  it('refuses to seal private content under the space key', () => {
    expect(() => sealDecodedRecord(ring, { id, space_id: 's', scope: 'space' }, busy)).toThrow(
      CryptoError,
    );
    expect(() =>
      sealDecodedRecord(ring, { id, space_id: 's', scope: 'space' }, privateList),
    ).toThrow(CryptoError);
    expect(() => sealDecodedRecord(ring, { id, space_id: 's', scope: 'user' }, stub)).toThrow(
      CryptoError,
    );
  });

  it('round-trips allowed records and tombstones', () => {
    const sealed = sealDecodedRecord(ring, { id, space_id: 's', scope: 'user' }, busy);
    expect(openDecodedRecord(ring, sealed.header, sealed)).toEqual({ ok: true, record: busy });
    const tomb: DecodedRecord = { kind: 'event', deleted: true, data: null, ...meta };
    const t = sealDecodedRecord(ring, { id, space_id: 's', scope: 'space' }, tomb);
    expect(t.header.deleted).toBe(true);
    expect(openDecodedRecord(ring, t.header, t)).toEqual({ ok: true, record: tomb });
    expect(
      scopeAllows(
        {
          ...meta,
          kind: 'list',
          deleted: false,
          data: { name: 'x', kind: 'check', private: false },
        },
        'space',
      ),
    ).toBe(true);
  });

  it('flags private content that arrives in space scope (buggy or malicious partner app)', () => {
    const k = ring.currentSpaceKey('s');
    const h: RecordHeader = {
      id,
      space_id: 's',
      scope: 'space',
      owner_user_id: null,
      key_version: k.version,
      deleted: false,
    };
    const bytes = utf8(
      JSON.stringify({ kind: 'event', schema: 1, ...meta, deleted: false, data: event }),
    );
    const sealed = encryptRecord(k.key, h, bytes);
    expect(openDecodedRecord(ring, h, sealed)).toEqual({ ok: false, reason: 'scope' });
    const lie = encryptRecord(
      k.key,
      h,
      utf8(JSON.stringify({ kind: 'event', schema: 1, ...meta, deleted: true, data: null })),
    );
    expect(openDecodedRecord(ring, h, lie)).toEqual({ ok: false, reason: 'invalid' });
    expect(openDecodedRecord(ring, h, encryptRecord(k.key, h, utf8('junk')))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
