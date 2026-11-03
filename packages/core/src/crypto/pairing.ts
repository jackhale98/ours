// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Invites: one-time transfer of key material through a link fragment.
 *
 * 1. The inviting device picks a random 32-byte secret s and derives
 *    wrapKey = HKDF(s, "ours/invite/v1").
 * 2. It encrypts the payload under wrapKey with AAD
 *    (label | kind | context_id) and uploads only the ciphertext.
 * 3. The link carries `<invite_id>.<base64url(s)>` in the URL fragment, which
 *    browsers never send to a server.
 *
 * Kinds:
 *  - 'partner': payload is the space keys; context_id is the space id.
 *  - 'device':  payload is the user's whole key ring; context_id is the user id.
 */
import { buildAad } from './aad';
import { open, type Sealed, seal } from './aead';
import {
  parseKeyRing,
  parseSpaceKeys,
  type SpaceKeyPayload,
  serializeKeyRing,
  serializeSpaceKeys,
} from './bundle';
import { CryptoError, fromBase64Url, randomBytes, toBase64Url } from './bytes';
import { deriveKey, LABELS } from './kdf';
import type { KeyRing } from './keys';

export type InviteKind = 'partner' | 'device';

export const INVITE_SECRET_LENGTH = 32;
const INVITE_ID = /^[A-Za-z0-9_-]{8,64}$/;

function inviteKey(secret: Uint8Array): Uint8Array {
  if (secret.length !== INVITE_SECRET_LENGTH) throw new CryptoError('invite', 'Bad invite secret');
  return deriveKey(secret, LABELS.invite);
}

function inviteAad(kind: InviteKind, contextId: string): Uint8Array {
  if (kind !== 'partner' && kind !== 'device') throw new CryptoError('format', 'Bad invite kind');
  if (!contextId) throw new CryptoError('format', 'Missing invite context');
  return buildAad([LABELS.invite, kind, contextId]);
}

export interface CreatedInvite {
  /** Stays on the inviting device until it is put in the link. Never uploaded. */
  secret: Uint8Array;
  /** Upload this. */
  wrapped: Sealed;
}

export function createPartnerInvite(payload: SpaceKeyPayload): CreatedInvite {
  const secret = randomBytes(INVITE_SECRET_LENGTH);
  const wrapped = seal(
    inviteKey(secret),
    serializeSpaceKeys(payload),
    inviteAad('partner', payload.space_id),
  );
  return { secret, wrapped };
}

/**
 * Opens a partner invite. `spaceId` is the space the server says the invite
 * belongs to; if it lies, decryption fails. The decrypted payload must name
 * the same space.
 */
export function openPartnerInvite(
  secret: Uint8Array,
  spaceId: string,
  wrapped: Sealed,
): SpaceKeyPayload {
  let plaintext: Uint8Array;
  try {
    plaintext = open(
      inviteKey(secret),
      wrapped.nonce,
      wrapped.ciphertext,
      inviteAad('partner', spaceId),
    );
  } catch (e) {
    throw asInviteError(e);
  }
  const payload = parseSpaceKeys(plaintext);
  if (payload.space_id !== spaceId) throw new CryptoError('invite', 'Invite space mismatch');
  return payload;
}

export function createDeviceInvite(ring: KeyRing): CreatedInvite {
  const secret = randomBytes(INVITE_SECRET_LENGTH);
  const wrapped = seal(inviteKey(secret), serializeKeyRing(ring), inviteAad('device', ring.userId));
  return { secret, wrapped };
}

/** `userId` is the signed-in user; a link for another account fails to open. */
export function openDeviceInvite(secret: Uint8Array, userId: string, wrapped: Sealed): KeyRing {
  let plaintext: Uint8Array;
  try {
    plaintext = open(
      inviteKey(secret),
      wrapped.nonce,
      wrapped.ciphertext,
      inviteAad('device', userId),
    );
  } catch (e) {
    throw asInviteError(e);
  }
  const ring = parseKeyRing(plaintext);
  if (ring.userId !== userId) throw new CryptoError('invite', 'Invite user mismatch');
  return ring;
}

function asInviteError(e: unknown): CryptoError {
  if (e instanceof CryptoError && e.code === 'decrypt') {
    return new CryptoError('invite', 'Invite could not be opened');
  }
  return e instanceof CryptoError ? e : new CryptoError('invite', 'Invite could not be opened');
}

/** Builds the URL fragment (without the leading '#'). */
export function formatInviteFragment(inviteId: string, secret: Uint8Array): string {
  if (!INVITE_ID.test(inviteId)) throw new CryptoError('format', 'Bad invite id');
  if (secret.length !== INVITE_SECRET_LENGTH) throw new CryptoError('invite', 'Bad invite secret');
  return `${inviteId}.${toBase64Url(secret)}`;
}

/** Parses `#<invite_id>.<secret>` (leading '#' optional). Throws on anything malformed. */
export function parseInviteFragment(fragment: string): { inviteId: string; secret: Uint8Array } {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) throw new CryptoError('invite', 'Malformed invite link');
  const inviteId = raw.slice(0, dot);
  if (!INVITE_ID.test(inviteId)) throw new CryptoError('invite', 'Malformed invite link');
  let secret: Uint8Array;
  try {
    secret = fromBase64Url(raw.slice(dot + 1));
  } catch {
    throw new CryptoError('invite', 'Malformed invite link');
  }
  if (secret.length !== INVITE_SECRET_LENGTH)
    throw new CryptoError('invite', 'Malformed invite link');
  return { inviteId, secret };
}
