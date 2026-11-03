// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notification payloads. The sender's device encrypts the text with the space
 * key; the server relays ciphertext inside Web Push; the receiving service
 * worker decrypts. `sent_at` is inside the ciphertext so stale replays can be
 * dropped by the receiver.
 */
import * as v from 'valibot';
import { buildAad } from './aad';
import { open, type Sealed, seal } from './aead';
import { CryptoError, fromUtf8, utf8 } from './bytes';
import { LABELS } from './kdf';
import { assertVersion } from './keys';

export const NotificationBody = v.strictObject({
  title: v.pipe(v.string(), v.maxLength(120)),
  body: v.pipe(v.string(), v.maxLength(400)),
  record_id: v.optional(v.pipe(v.string(), v.maxLength(128))),
  sent_at: v.pipe(v.number(), v.integer()),
});
export type NotificationBody = v.InferOutput<typeof NotificationBody>;

/** Notifications older than this are ignored by the receiver. */
export const NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function notifyAad(spaceId: string, keyVersion: number): Uint8Array {
  assertVersion(keyVersion);
  return buildAad([LABELS.notify, spaceId, keyVersion]);
}

export function sealNotification(
  key: Uint8Array,
  spaceId: string,
  keyVersion: number,
  body: NotificationBody,
): Sealed {
  const parsed = v.parse(NotificationBody, body);
  return seal(key, utf8(JSON.stringify(parsed)), notifyAad(spaceId, keyVersion));
}

/** Returns null for stale notifications. Throws CryptoError on any other failure. */
export function openNotification(
  key: Uint8Array,
  spaceId: string,
  keyVersion: number,
  sealed: Sealed,
  now = Date.now(),
): NotificationBody | null {
  const bytes = open(key, sealed.nonce, sealed.ciphertext, notifyAad(spaceId, keyVersion));
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(bytes));
  } catch {
    throw new CryptoError('format', 'Malformed notification');
  }
  const result = v.safeParse(NotificationBody, json);
  if (!result.success) throw new CryptoError('format', 'Malformed notification');
  if (Math.abs(now - result.output.sent_at) > NOTIFICATION_MAX_AGE_MS) return null;
  return result.output;
}
