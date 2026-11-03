// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notification payloads. The sender's device encrypts the text with the space
 * key; the server relays ciphertext inside Web Push; the receiving service
 * worker decrypts.
 *
 * Freshness is authenticated inside the ciphertext:
 * - `not_before`/`expires_at` bound when the payload may be shown, so
 *   scheduled reminders work and the server cannot deliver them early or late;
 * - `nid` is a random id; the receiver remembers ids it has shown (until
 *   `expires_at`) and drops replays.
 *
 * The AAD names the recipient (a user id) and which key sealed it:
 * - 'space': notifications for the partner, under the shared space key;
 * - 'user': reminders for oneself, under the personal key, so a reminder
 *   about a private plan can never be opened by the partner.
 * The server therefore cannot redirect a payload to someone else: their
 * device checks the AAD against its own user id and fails closed.
 */
import * as v from 'valibot';
import { buildAad } from './aad';
import { open, type Sealed, seal } from './aead';
import { CryptoError, fromUtf8, randomBytes, toBase64Url, utf8 } from './bytes';
import { LABELS } from './kdf';
import { assertVersion } from './keys';

const Ms = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2 ** 48));

export const NotificationBody = v.pipe(
  v.strictObject({
    nid: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
    title: v.pipe(v.string(), v.maxLength(120)),
    body: v.pipe(v.string(), v.maxLength(400)),
    record_id: v.optional(v.pipe(v.string(), v.maxLength(128))),
    /** Lets the receiving device offer the right actions (e.g. "Yes" on a proposal). */
    kind: v.optional(v.picklist(['proposal', 'answer', 'note', 'reminder', 'test'])),
    not_before: Ms,
    expires_at: Ms,
  }),
  v.check(
    (b) => b.expires_at > b.not_before && b.expires_at - b.not_before <= MAX_LIFETIME_MS,
    'Invalid notification lifetime',
  ),
);
export type NotificationBody = v.InferOutput<typeof NotificationBody>;
export type NotificationInput = Omit<NotificationBody, 'nid' | 'not_before' | 'expires_at'> & {
  /** When it may first be shown (default: now). For reminders, the fire time. */
  not_before?: number;
  /** How long after not_before it stays valid (default 24 h). */
  ttl_ms?: number;
};

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_LIFETIME_MS = 7 * DEFAULT_TTL_MS;
/** Tolerated clock difference between sender and receiver. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface NotifyTarget {
  space_id: string;
  /** Which key sealed it: the shared space key, or the recipient's personal key. */
  scope: 'space' | 'user';
  /** User id of the person it is for. */
  recipient: string;
}

function notifyAad(to: NotifyTarget, keyVersion: number): Uint8Array {
  assertVersion(keyVersion);
  if (to.scope !== 'space' && to.scope !== 'user')
    throw new CryptoError('format', 'Invalid notification scope');
  if (!to.recipient) throw new CryptoError('format', 'Missing recipient');
  return buildAad([LABELS.notify, to.space_id, keyVersion, to.scope, to.recipient]);
}

export function sealNotification(
  key: Uint8Array,
  to: NotifyTarget,
  keyVersion: number,
  input: NotificationInput,
  now = Date.now(),
): Sealed {
  const { ttl_ms = DEFAULT_TTL_MS, not_before = now, ...rest } = input;
  const result = v.safeParse(NotificationBody, {
    ...rest,
    nid: toBase64Url(randomBytes(16)),
    not_before,
    expires_at: not_before + ttl_ms,
  });
  if (!result.success) throw new CryptoError('format', 'Invalid notification');
  return seal(key, utf8(JSON.stringify(result.output)), notifyAad(to, keyVersion));
}

export type OpenedNotification =
  | { status: 'show'; body: NotificationBody }
  | { status: 'early' | 'expired' | 'duplicate' };

/**
 * Decrypts and checks freshness. `seen(nid)` reports whether this device
 * already showed that id; the caller records ids it shows.
 * Throws CryptoError if the payload is not authentic or malformed.
 */
export function openNotification(
  key: Uint8Array,
  to: NotifyTarget,
  keyVersion: number,
  sealed: Sealed,
  now: number,
  seen: (nid: string) => boolean,
): OpenedNotification {
  const bytes = open(key, sealed.nonce, sealed.ciphertext, notifyAad(to, keyVersion));
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(bytes));
  } catch {
    throw new CryptoError('format', 'Malformed notification');
  }
  const result = v.safeParse(NotificationBody, json);
  if (!result.success) throw new CryptoError('format', 'Malformed notification');
  const body = result.output;
  if (now + CLOCK_SKEW_MS < body.not_before) return { status: 'early' };
  if (now - CLOCK_SKEW_MS > body.expires_at) return { status: 'expired' };
  if (seen(body.nid)) return { status: 'duplicate' };
  return { status: 'show', body };
}
