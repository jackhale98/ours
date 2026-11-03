// SPDX-License-Identifier: AGPL-3.0-or-later
import { KEY_LENGTH } from './aead';
import { CryptoError, randomBytes } from './bytes';

/** A symmetric key together with its version number (starts at 1). */
export interface VersionedKey {
  version: number;
  key: Uint8Array;
}

/** Generates a new random 256-bit symmetric key (space key or personal key). */
export function generateKey(): Uint8Array {
  return randomBytes(KEY_LENGTH);
}

export function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new CryptoError('format', 'Key version must be a positive integer');
  }
}

/**
 * The set of keys a device holds. Space keys are per space and versioned
 * (rotation adds a version); personal keys are versioned the same way.
 */
export class KeyRing {
  readonly userId: string;
  private readonly personal = new Map<number, Uint8Array>();
  private readonly spaces = new Map<string, Map<number, Uint8Array>>();

  constructor(userId: string) {
    this.userId = userId;
  }

  addPersonalKey({ version, key }: VersionedKey): void {
    assertVersion(version);
    if (key.length !== KEY_LENGTH) throw new CryptoError('key', 'Key must be 32 bytes');
    this.personal.set(version, key);
  }

  addSpaceKey(spaceId: string, { version, key }: VersionedKey): void {
    assertVersion(version);
    if (key.length !== KEY_LENGTH) throw new CryptoError('key', 'Key must be 32 bytes');
    let versions = this.spaces.get(spaceId);
    if (!versions) {
      versions = new Map();
      this.spaces.set(spaceId, versions);
    }
    versions.set(version, key);
  }

  removeSpace(spaceId: string): void {
    this.spaces.delete(spaceId);
  }

  personalKey(version: number): Uint8Array {
    const key = this.personal.get(version);
    if (!key) throw new CryptoError('unknown-key-version', 'Unknown personal key version');
    return key;
  }

  spaceKey(spaceId: string, version: number): Uint8Array {
    const key = this.spaces.get(spaceId)?.get(version);
    if (!key) throw new CryptoError('unknown-key-version', 'Unknown space key version');
    return key;
  }

  currentPersonalKey(): VersionedKey {
    return latest(this.personal, 'personal');
  }

  currentSpaceKey(spaceId: string): VersionedKey {
    return latest(this.spaces.get(spaceId) ?? new Map(), 'space');
  }

  spaceIds(): string[] {
    return [...this.spaces.keys()];
  }

  spaceKeys(spaceId: string): VersionedKey[] {
    return sorted(this.spaces.get(spaceId) ?? new Map());
  }

  personalKeys(): VersionedKey[] {
    return sorted(this.personal);
  }
}

function sorted(map: Map<number, Uint8Array>): VersionedKey[] {
  return [...map.entries()].sort(([a], [b]) => a - b).map(([version, key]) => ({ version, key }));
}

function latest(map: Map<number, Uint8Array>, what: string): VersionedKey {
  const all = sorted(map);
  const last = all[all.length - 1];
  if (!last) throw new CryptoError('unknown-key-version', `No ${what} key`);
  return last;
}
