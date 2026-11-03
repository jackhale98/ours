// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The key ring at rest. Serialised with core's strict format, then wrapped
 * with an AES-GCM key generated as non-extractable: JavaScript on this origin
 * can use it but nobody can export it, so copying the IndexedDB files off the
 * device does not reveal the keys.
 */
import { KeyRing, parseKeyRing, serializeKeyRing } from '@ours/core/crypto';
import { kvGet, kvSet } from './db';

async function wrappingKey(): Promise<CryptoKey> {
  const existing = await kvGet<CryptoKey>('device-key');
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await kvSet('device-key', key);
  return key;
}

export async function saveRing(ring: KeyRing): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = Uint8Array.from(serializeKeyRing(ring));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('ours/keyring/v1') },
      await wrappingKey(),
      data,
    ),
  );
  data.fill(0);
  await kvSet('keyring', { iv, ct });
}

export async function loadRing(): Promise<KeyRing | null> {
  const stored = await kvGet<{ iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }>(
    'keyring',
  );
  if (!stored) return null;
  const pt = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: stored.iv,
        additionalData: new TextEncoder().encode('ours/keyring/v1'),
      },
      await wrappingKey(),
      stored.ct,
    ),
  );
  const ring = parseKeyRing(pt);
  pt.fill(0);
  return ring;
}

export { KeyRing };
