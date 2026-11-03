// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { seal } from './aead';
import { parseKeyRing, parseSpaceKeys, serializeKeyRing, serializeSpaceKeys } from './bundle';
import { CryptoError, randomBytes, toBase64Url, utf8 } from './bytes';
import { generateKey, KeyRing } from './keys';
import {
  createDeviceInvite,
  createPartnerInvite,
  formatInviteFragment,
  openDeviceInvite,
  openPartnerInvite,
  parseInviteFragment,
} from './pairing';
import { safetyCode } from './safety';

const SPACE = '0190a6c8-7a3e-7cc2-9b1d-3f6e2a1b4c5d';
const INVITE_ID = '0190a6c8-7a3e-7cc2-9b1d-000000000001';

describe('partner invite', () => {
  it('transfers every space key version and yields matching safety codes', () => {
    const v1 = generateKey();
    const v2 = generateKey();
    const { secret, wrapped } = createPartnerInvite({
      space_id: SPACE,
      keys: [
        { version: 1, key: v1 },
        { version: 2, key: v2 },
      ],
      inviter_name: 'Sam',
    });
    const fragment = formatInviteFragment(INVITE_ID, secret);
    const parsed = parseInviteFragment(`#${fragment}`);
    expect(parsed.inviteId).toBe(INVITE_ID);
    const payload = openPartnerInvite(parsed.secret, SPACE, wrapped);
    expect(payload.inviter_name).toBe('Sam');
    expect(payload.keys).toEqual([
      { version: 1, key: v1 },
      { version: 2, key: v2 },
    ]);
    expect(safetyCode(SPACE, 2, payload.keys[1]?.key ?? new Uint8Array())).toBe(
      safetyCode(SPACE, 2, v2),
    );
  });

  it('fails with the wrong secret', () => {
    const { wrapped } = createPartnerInvite({
      space_id: SPACE,
      keys: [{ version: 1, key: generateKey() }],
    });
    expect(() => openPartnerInvite(randomBytes(32), SPACE, wrapped)).toThrow(
      expect.objectContaining({ code: 'invite' }),
    );
  });

  it('fails if the server claims a different space', () => {
    const { secret, wrapped } = createPartnerInvite({
      space_id: SPACE,
      keys: [{ version: 1, key: generateKey() }],
    });
    expect(() => openPartnerInvite(secret, 'other-space', wrapped)).toThrow(
      expect.objectContaining({ code: 'invite' }),
    );
  });

  it('fails if the blob is tampered', () => {
    const { secret, wrapped } = createPartnerInvite({
      space_id: SPACE,
      keys: [{ version: 1, key: generateKey() }],
    });
    const ciphertext = wrapped.ciphertext.slice();
    ciphertext[5] = (ciphertext[5] ?? 0) ^ 1;
    expect(() => openPartnerInvite(secret, SPACE, { ...wrapped, ciphertext })).toThrow(CryptoError);
  });

  it('rejects a device invite presented as a partner invite', () => {
    const ring = new KeyRing(SPACE); // user id equal to space id to isolate the kind check
    ring.addPersonalKey({ version: 1, key: generateKey() });
    const { secret, wrapped } = createDeviceInvite(ring);
    expect(() => openPartnerInvite(secret, SPACE, wrapped)).toThrow(CryptoError);
  });

  it('rejects a payload whose inner space id differs from the AAD', async () => {
    // Simulate a malicious inviter: payload names space B, wrapped for space A.
    const { deriveKey, LABELS } = await import('./kdf');
    const { buildAad } = await import('./aad');
    const secret = randomBytes(32);
    const wrapped = seal(
      deriveKey(secret, LABELS.invite),
      serializeSpaceKeys({ space_id: 'space-b', keys: [{ version: 1, key: generateKey() }] }),
      buildAad([LABELS.invite, 'partner', SPACE]),
    );
    expect(() => openPartnerInvite(secret, SPACE, wrapped)).toThrow(
      expect.objectContaining({ code: 'invite' }),
    );
  });
});

describe('device invite', () => {
  function fullRing(): KeyRing {
    const ring = new KeyRing('sam');
    ring.addPersonalKey({ version: 1, key: generateKey() });
    ring.addSpaceKey('s1', { version: 1, key: generateKey() });
    ring.addSpaceKey('s1', { version: 2, key: generateKey() });
    ring.addSpaceKey('s2', { version: 1, key: generateKey() });
    return ring;
  }

  it('transfers the whole key ring', () => {
    const ring = fullRing();
    const { secret, wrapped } = createDeviceInvite(ring);
    const copy = openDeviceInvite(secret, 'sam', wrapped);
    expect(copy.userId).toBe('sam');
    expect(copy.personalKeys()).toEqual(ring.personalKeys());
    expect(copy.spaceKeys('s1')).toEqual(ring.spaceKeys('s1'));
    expect(copy.spaceKeys('s2')).toEqual(ring.spaceKeys('s2'));
  });

  it('cannot be opened by another account', () => {
    const { secret, wrapped } = createDeviceInvite(fullRing());
    expect(() => openDeviceInvite(secret, 'alex', wrapped)).toThrow(
      expect.objectContaining({ code: 'invite' }),
    );
  });
});

describe('invite fragment', () => {
  const secret = randomBytes(32);

  it('round-trips with or without #', () => {
    const f = formatInviteFragment(INVITE_ID, secret);
    expect(parseInviteFragment(f).secret).toEqual(secret);
    expect(parseInviteFragment(`#${f}`).secret).toEqual(secret);
  });

  it.each([
    '',
    '#',
    'no-dot-here',
    `.${toBase64Url(randomBytes(32))}`,
    `short.${toBase64Url(randomBytes(32))}`,
    `${INVITE_ID}.${toBase64Url(randomBytes(31))}`,
    `${INVITE_ID}.${toBase64Url(randomBytes(33))}`,
    `${INVITE_ID}.not*base64`,
    `bad id with spaces.${toBase64Url(randomBytes(32))}`,
  ])('rejects malformed fragment %j', (bad) => {
    expect(() => parseInviteFragment(bad)).toThrow(expect.objectContaining({ code: 'invite' }));
  });

  it('refuses to format bad inputs', () => {
    expect(() => formatInviteFragment('x', secret)).toThrow(CryptoError);
    expect(() => formatInviteFragment(INVITE_ID, randomBytes(16))).toThrow(CryptoError);
  });

  it('rejects short secrets when opening', () => {
    const { wrapped } = createPartnerInvite({
      space_id: SPACE,
      keys: [{ version: 1, key: generateKey() }],
    });
    expect(() => openPartnerInvite(randomBytes(16), SPACE, wrapped)).toThrow(CryptoError);
  });
});

describe('bundle parsing', () => {
  it('round-trips a key ring', () => {
    const ring = new KeyRing('u');
    ring.addPersonalKey({ version: 1, key: generateKey() });
    const copy = parseKeyRing(serializeKeyRing(ring));
    expect(copy.personalKeys()).toEqual(ring.personalKeys());
  });

  it.each([
    ['not json', 'nope'],
    ['wrong version', JSON.stringify({ v: 2, user_id: 'u', personal: [], spaces: [] })],
    ['no personal keys', JSON.stringify({ v: 1, user_id: 'u', personal: [], spaces: [] })],
    [
      'extra field',
      JSON.stringify({
        v: 1,
        user_id: 'u',
        personal: [{ version: 1, key: toBase64Url(generateKey()) }],
        spaces: [],
        evil: true,
      }),
    ],
    [
      'short key',
      JSON.stringify({
        v: 1,
        user_id: 'u',
        personal: [{ version: 1, key: toBase64Url(randomBytes(31)) }],
        spaces: [],
      }),
    ],
    [
      'duplicate version',
      JSON.stringify({
        v: 1,
        user_id: 'u',
        personal: [
          { version: 1, key: toBase64Url(generateKey()) },
          { version: 1, key: toBase64Url(generateKey()) },
        ],
        spaces: [],
      }),
    ],
    [
      'duplicate space',
      JSON.stringify({
        v: 1,
        user_id: 'u',
        personal: [{ version: 1, key: toBase64Url(generateKey()) }],
        spaces: [
          { space_id: 's', keys: [{ version: 1, key: toBase64Url(generateKey()) }] },
          { space_id: 's', keys: [{ version: 2, key: toBase64Url(generateKey()) }] },
        ],
      }),
    ],
  ])('rejects %s', (_name, text) => {
    expect(() => parseKeyRing(utf8(text))).toThrow(CryptoError);
  });

  it('rejects invalid space key payloads', () => {
    expect(() => parseSpaceKeys(utf8('{}'))).toThrow(CryptoError);
    expect(() => parseSpaceKeys(new Uint8Array([0xff]))).toThrow(CryptoError);
  });
});
