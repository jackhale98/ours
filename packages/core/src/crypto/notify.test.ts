// SPDX-License-Identifier: AGPL-3.0-or-later
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { describe, expect, it } from 'vitest';
import { buildAad } from './aad';
import { pad } from './aead';
import { CryptoError, randomBytes, utf8 } from './bytes';
import { LABELS } from './kdf';
import { generateKey } from './keys';
import { NOTIFICATION_MAX_AGE_MS, openNotification, sealNotification } from './notify';

const now = 1_800_000_000_000;
const body = { title: 'Sam', body: 'Dinner Friday?', record_id: 'r1', sent_at: now };

describe('notifications', () => {
  it('round-trips', () => {
    const key = generateKey();
    const sealed = sealNotification(key, 's', 1, body);
    expect(openNotification(key, 's', 1, sealed, now + 1000)).toEqual(body);
  });

  it('is opaque: plaintext text does not appear in ciphertext', () => {
    const sealed = sealNotification(generateKey(), 's', 1, body);
    expect(Buffer.from(sealed.ciphertext).includes(Buffer.from('Dinner'))).toBe(false);
  });

  it('drops stale replays', () => {
    const key = generateKey();
    const sealed = sealNotification(key, 's', 1, body);
    expect(openNotification(key, 's', 1, sealed, now + NOTIFICATION_MAX_AGE_MS + 1)).toBeNull();
  });

  it('fails for another space, version or key', () => {
    const key = generateKey();
    const sealed = sealNotification(key, 's', 1, body);
    expect(() => openNotification(key, 't', 1, sealed, now)).toThrow(CryptoError);
    expect(() => openNotification(key, 's', 2, sealed, now)).toThrow(CryptoError);
    expect(() => openNotification(generateKey(), 's', 1, sealed, now)).toThrow(CryptoError);
  });

  it('rejects malformed bodies on both ends', () => {
    expect(() =>
      sealNotification(generateKey(), 's', 1, { ...body, title: 'x'.repeat(500) }),
    ).toThrow();
    const key = generateKey();
    const nonce = randomBytes(24);
    const aad = buildAad([LABELS.notify, 's', 1]);
    const forge = (text: string) => ({
      nonce,
      ciphertext: xchacha20poly1305(key, nonce, aad).encrypt(pad(utf8(text))),
    });
    expect(() => openNotification(key, 's', 1, forge('not json'), now)).toThrow(
      expect.objectContaining({ code: 'format' }),
    );
    expect(() => openNotification(key, 's', 1, forge('{"title":1}'), now)).toThrow(
      expect.objectContaining({ code: 'format' }),
    );
  });
});
