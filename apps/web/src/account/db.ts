// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * On-device storage (IndexedDB). Everything that holds user content is
 * ciphertext: envelopes and outbox entries are the same encrypted envelopes
 * the server stores, and the key ring is wrapped with a non-extractable
 * WebCrypto key that never leaves this browser.
 */
import type { Envelope, EnvelopeInput } from '@ours/core/schema';
import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from 'idb';

export interface OutboxEntry {
  envelope: EnvelopeInput;
  base_rev: number;
  /** Set while a push containing this entry is in flight. */
  sent_nonce?: string;
}

interface OursDB extends DBSchema {
  kv: { key: string; value: unknown };
  envelopes: { key: string; value: Envelope };
  outbox: { key: string; value: OutboxEntry };
}

const NAME = 'ours';
let dbp: Promise<IDBPDatabase<OursDB>> | null = null;

export function db(): Promise<IDBPDatabase<OursDB>> {
  dbp ??= openDB<OursDB>(NAME, 1, {
    upgrade(d) {
      d.createObjectStore('kv');
      d.createObjectStore('envelopes');
      d.createObjectStore('outbox');
    },
  });
  return dbp;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}

/** Removes everything this app stored on the device. */
export async function wipe(): Promise<void> {
  const d = await dbp;
  d?.close();
  dbp = null;
  await deleteDB(NAME);
}
