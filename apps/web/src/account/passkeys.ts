// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Small checks for passkey unlock (ADR 0015, review 0006), kept apart from
 * session.ts so they can be tested on their own.
 */

/**
 * Whether the person confirmed with face, fingerprint or device passcode:
 * the UV flag (bit 2) of the authenticator data's flags byte, after the
 * 32-byte RP id hash (review 0006, M2). Without it the passkey's unlock
 * secret isn't used.
 */
export function userVerified(authenticatorData: Uint8Array): boolean {
  return authenticatorData.length > 32 && ((authenticatorData[32] ?? 0) & 0x04) !== 0;
}

/**
 * Who made a passkey, from its AAGUID, so people can tell theirs apart
 * (review 0006, M1). Only providers whose AAGUID is well known; others are
 * just "Passkey".
 */
const PROVIDERS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
};

export function providerName(aaguid: string | null | undefined): string | null {
  if (!aaguid || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(aaguid)) return null;
  return PROVIDERS[aaguid.toLowerCase()] ?? null;
}

export type UnlockStatus =
  /** Can't unlock: added before the latest change of keys (it may be on the lost phone). */
  | 'too-old'
  /** Signs in only. */
  | 'off'
  /** Unlocks the current keys. */
  | 'current'
  /** Holds older keys; this device set it up, so it can update it. */
  | 'behind'
  /** Holds older keys and was set up on another device: not offered for update here. */
  | 'behind-elsewhere';

/**
 * What a passkey does for unlocking, from what the server lists and what this
 * device remembers setting up (review 0006, M1 and L4).
 */
export function unlockStatus(
  passkey: { id: string; can_unlock: boolean },
  copy: { created_at: number; space_version: number; personal_version: number } | undefined,
  current: { space: number; personal: number },
  madeHere: Record<string, number>,
): UnlockStatus {
  if (!copy) return passkey.can_unlock ? 'off' : 'too-old';
  if (copy.space_version === current.space && copy.personal_version === current.personal)
    return 'current';
  return madeHere[passkey.id] === copy.created_at ? 'behind' : 'behind-elsewhere';
}
