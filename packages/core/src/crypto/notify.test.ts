// SPDX-License-Identifier: AGPL-3.0-or-later

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { buildAad } from './aad';
import { pad } from './aead';
import { CryptoError, randomBytes, utf8 } from './bytes';
import { LABELS } from './kdf';
import { generateKey } from './keys';
import { CLOCK_SKEW_MS, DEFAULT_TTL_MS, openNotification, sealNotification } from './notify';

const now = 1_800_000_000_000;
const input = { title: 'Sam', body: 'Dinner Friday?', record_id: 'r1' };
const never = () => false;

describe('notifications', () => {
  it('round-trips with a random id and a default 24 h lifetime', () => {
    const key = generateKey();
    const out = openNotification(
      key,
      's',
      1,
      sealNotification(key, 's', 1, input, now),
      now + 1000,
      never,
    );
    expect(out.status).toBe('show');
    if (out.status !== 'show') return;
    expect(out.body).toMatchObject({ ...input, not_before: now, expires_at: now + DEFAULT_TTL_MS });
    expect(out.body.nid).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('is opaque: plaintext does not appear in the ciphertext', () => {
    const sealed = sealNotification(generateKey(), 's', 1, input, now);
    expect(bytesToHex(sealed.ciphertext)).not.toContain(bytesToHex(utf8('Dinner')));
  });

  it('drops duplicates the receiver has already shown', () => {
    const key = generateKey();
    const sealed = sealNotification(key, 's', 1, input, now);
    const shown = new Set<string>();
    const first = openNotification(key, 's', 1, sealed, now, (id) => shown.has(id));
    if (first.status === 'show') shown.add(first.body.nid);
    expect(openNotification(key, 's', 1, sealed, now, (id) => shown.has(id))).toEqual({
      status: 'duplicate',
    });
  });

  it('enforces the authenticated time window, allowing small clock skew', () => {
    const key = generateKey();
    const reminder = sealNotification(
      key,
      's',
      1,
      { ...input, not_before: now + 3 * DEFAULT_TTL_MS, ttl_ms: 60_000 },
      now,
    );
    expect(openNotification(key, 's', 1, reminder, now, never)).toEqual({ status: 'early' });
    const at = now + 3 * DEFAULT_TTL_MS;
    expect(openNotification(key, 's', 1, reminder, at - CLOCK_SKEW_MS + 1, never).status).toBe(
      'show',
    );
    expect(openNotification(key, 's', 1, reminder, at + 60_000 + CLOCK_SKEW_MS + 1, never)).toEqual(
      {
        status: 'expired',
      },
    );
  });

  it('refuses lifetimes over 7 days and oversized text', () => {
    const key = generateKey();
    expect(() =>
      sealNotification(key, 's', 1, { ...input, ttl_ms: 8 * DEFAULT_TTL_MS }, now),
    ).toThrow(CryptoError);
    expect(() => sealNotification(key, 's', 1, { ...input, ttl_ms: 0 }, now)).toThrow(CryptoError);
    expect(() => sealNotification(key, 's', 1, { ...input, title: 'x'.repeat(500) }, now)).toThrow(
      CryptoError,
    );
  });

  it('does not leak content in validation errors', () => {
    try {
      sealNotification(generateKey(), 's', 1, { ...input, body: `SECRET${'x'.repeat(500)}` }, now);
    } catch (e) {
      expect(String(e)).not.toContain('SECRET');
      expect(JSON.stringify(e)).not.toContain('SECRET');
    }
  });

  it('fails for another space, version or key', () => {
    const key = generateKey();
    const sealed = sealNotification(key, 's', 1, input, now);
    expect(() => openNotification(key, 't', 1, sealed, now, never)).toThrow(CryptoError);
    expect(() => openNotification(key, 's', 2, sealed, now, never)).toThrow(CryptoError);
    expect(() => openNotification(generateKey(), 's', 1, sealed, now, never)).toThrow(CryptoError);
  });

  it('rejects authentic but malformed bodies', () => {
    const key = generateKey();
    const nonce = randomBytes(24);
    const aad = buildAad([LABELS.notify, 's', 1]);
    const forge = (text: string) => ({
      nonce,
      ciphertext: xchacha20poly1305(key, nonce, aad).encrypt(pad(utf8(text))),
    });
    expect(() => openNotification(key, 's', 1, forge('not json'), now, never)).toThrow(
      expect.objectContaining({ code: 'format' }),
    );
    expect(() => openNotification(key, 's', 1, forge('{"title":1}'), now, never)).toThrow(
      expect.objectContaining({ code: 'format' }),
    );
  });
});
