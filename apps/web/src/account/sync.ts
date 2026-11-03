// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The sync engine for a signed-in account (ADR 0004).
 *
 * - Local writes are sealed (encrypted, scope-checked) and put in an
 *   IndexedDB outbox with the rev they were based on, then pushed in batches.
 * - Pulls fetch envelopes after a stored cursor, decrypt them on device and
 *   merge with any pending local change (core/sync mergeRecord).
 * - The server's copy of each record is kept (as ciphertext) as the merge base.
 * - Triggers: start, visibility regained, every 30 s while visible, 500 ms
 *   after local writes, and on demand (e.g. a push notification).
 */
import {
  CryptoError,
  fromBase64Url,
  type KeyRing,
  openDecodedRecord,
  type RecordHeader,
  sealDecodedRecord,
  toBase64Url,
} from '@ours/core/crypto';
import type { DecodedRecord, Envelope, EnvelopeInput } from '@ours/core/schema';
import { MAX_PUSH, mergeRecord, type PullResponse, type PushResponse } from '@ours/core/sync';
import { signal } from '@preact/signals';
import {
  applyRemote,
  type Backend,
  type Entry,
  loadEntries,
  type Slot,
  setBackend,
} from '../app/model';
import { ApiError, api } from './api';
import { db, kvGet, kvSet, type OutboxEntry } from './db';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';
export const syncStatus = signal<SyncStatus>('syncing');

export interface SyncContext {
  ring: KeyRing;
  userId: string;
  deviceId: string;
  spaceId: string;
  slot: Slot;
  /** Minimum key versions after a rotation, and the revision it happened at (ADR 0013). */
  floor?: { space: number; personal: number; rotatedRev: number };
}

/** True when this device lacks the keys the server now requires (ADR 0013). */
export const needsNewKeys = signal(false);

type Live = Extract<DecodedRecord, { deleted: false }>;

const headerOf = (e: Envelope | EnvelopeInput): RecordHeader => ({
  id: e.id,
  space_id: e.space_id,
  scope: e.scope,
  owner_user_id: e.owner_user_id,
  key_version: e.key_version,
  deleted: e.deleted,
});

export class SyncEngine implements Backend {
  readonly mode = 'account' as const;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(private readonly ctx: SyncContext) {}

  deviceId(): string {
    return this.ctx.deviceId;
  }

  private cursorKey() {
    return `cursor:${this.ctx.spaceId}`;
  }

  private slotFor(ownerUserId: string | null): Slot | null {
    if (ownerUserId === null) return null;
    return ownerUserId === this.ctx.userId ? this.ctx.slot : this.ctx.slot === 'a' ? 'b' : 'a';
  }

  /** The newest key version this device holds for a record's scope. */
  private latestVersion(scope: 'space' | 'user'): number {
    const keys =
      scope === 'user' ? this.ctx.ring.personalKeys() : this.ctx.ring.spaceKeys(this.ctx.spaceId);
    return Math.max(0, ...keys.map((k) => k.version));
  }

  /** A record under a key version this device doesn't have yet. */
  private unknownKey(e: Envelope | EnvelopeInput): boolean {
    return e.key_version > this.latestVersion(e.scope);
  }

  /** Decrypts and validates an envelope. Null if this device can't or shouldn't show it. */
  private open(e: Envelope | EnvelopeInput): DecodedRecord | null {
    // After a rotation, old keys are decrypt-only: a record under an old
    // version that the server says arrived after the rotation is refused
    // (crypto review 0001, M1).
    const floor = this.ctx.floor;
    if (floor && 'rev' in e) {
      const min = e.scope === 'user' ? floor.personal : floor.space;
      const own = e.scope === 'space' || e.owner_user_id === this.ctx.userId;
      if (own && e.key_version < min && e.rev > floor.rotatedRev) return null;
    }
    try {
      const r = openDecodedRecord(this.ctx.ring, headerOf(e), {
        nonce: fromBase64Url(e.nonce),
        ciphertext: fromBase64Url(e.ciphertext),
      });
      return r.ok ? r.record : null;
    } catch (err) {
      if (!(err instanceof CryptoError)) throw err;
      return null;
    }
  }

  private toEntry(e: Envelope | EnvelopeInput, rec: DecodedRecord): Entry | null {
    if (rec.deleted) return null;
    return { id: e.id, scope: e.scope, owner: this.slotFor(e.owner_user_id), rec: rec as Live };
  }

  private seal(entry: { id: string; scope: 'space' | 'user' }, rec: DecodedRecord): EnvelopeInput {
    const sealed = sealDecodedRecord(
      this.ctx.ring,
      { id: entry.id, space_id: this.ctx.spaceId, scope: entry.scope },
      rec,
    );
    return {
      ...sealed.header,
      nonce: toBase64Url(sealed.nonce),
      ciphertext: toBase64Url(sealed.ciphertext),
    } as EnvelopeInput;
  }

  /** Loads the local copy (server versions overlaid with pending writes) into the UI. */
  async start(): Promise<void> {
    const d = await db();
    const [envelopes, outbox] = await Promise.all([d.getAll('envelopes'), d.getAllKeys('outbox')]);
    const pending = new Map<string, OutboxEntry>();
    for (const id of outbox) {
      const o = await d.get('outbox', id);
      if (o) pending.set(String(id), o);
    }
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const [id, o] of pending) {
      // Written before this device got the new keys: re-seal under them.
      if (o.envelope.key_version < this.latestVersion(o.envelope.scope)) {
        const rec = this.open(o.envelope);
        if (rec) {
          o.envelope = this.seal(o.envelope, rec);
          await d.put('outbox', o, id);
        }
      }
    }
    for (const o of pending.values()) {
      seen.add(o.envelope.id);
      const rec = this.open(o.envelope);
      const entry = rec && this.toEntry(o.envelope, rec);
      if (entry) entries.push(entry);
    }
    for (const e of envelopes) {
      if (e.space_id !== this.ctx.spaceId || seen.has(e.id)) continue;
      const rec = this.open(e);
      const entry = rec && this.toEntry(e, rec);
      if (entry) entries.push(entry);
    }
    loadEntries(this.ctx.slot, entries);
    setBackend(this);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.sync();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', () => void this.sync());
    this.interval = setInterval(() => {
      if (document.visibilityState === 'visible') void this.sync();
    }, 30_000);
    void this.sync();
  }

  /** `restarting`: a new engine takes over at once, so the app stays in account mode. */
  stop(restarting = false): void {
    this.stopped = true;
    clearInterval(this.interval);
    clearTimeout(this.pushTimer);
    if (!restarting) setBackend(null);
  }

  /** Backend: encrypt local changes into the outbox, then push soon. */
  write(upserts: Entry[], removed: Entry[]): void {
    // Honest status: a local change isn't synced until it has been pushed.
    syncStatus.value = 'syncing';
    void this.enqueue(upserts, removed).then(() => {
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => void this.sync(), 500);
    });
  }

  private async enqueue(upserts: Entry[], removed: Entry[]): Promise<void> {
    const d = await db();
    const tx = d.transaction(['outbox', 'envelopes'], 'readwrite');
    const now = Date.now();
    const writes: [string, EnvelopeInput][] = [];
    for (const e of upserts) writes.push([e.id, this.seal(e, e.rec)]);
    for (const e of removed) {
      const tomb: DecodedRecord = {
        kind: e.rec.kind,
        deleted: true,
        data: null,
        updated_at: Math.max(now, e.rec.updated_at + 1),
        device_id: this.ctx.deviceId,
      };
      writes.push([e.id, this.seal(e, tomb)]);
    }
    for (const [id, envelope] of writes) {
      const existing = await tx.objectStore('outbox').get(id);
      const base = await tx.objectStore('envelopes').get(id);
      await tx
        .objectStore('outbox')
        .put({ envelope, base_rev: existing?.base_rev ?? base?.rev ?? 0 }, id);
    }
    await tx.done;
  }

  /**
   * After a rotation: re-seal every record this device can read and write
   * under the newest keys and push them, so live data no longer depends on
   * keys a removed device holds (ADR 0013).
   */
  async reencryptAll(): Promise<number> {
    const d = await db();
    const envelopes = (await d.getAll('envelopes')).filter(
      (e) =>
        e.space_id === this.ctx.spaceId &&
        (e.scope === 'space' || e.owner_user_id === this.ctx.userId) &&
        e.key_version < this.latestVersion(e.scope),
    );
    const tx = d.transaction(['outbox'], 'readwrite');
    let n = 0;
    for (const e of envelopes) {
      const pending = await tx.objectStore('outbox').get(e.id);
      const source = pending?.envelope ?? e;
      const rec = this.open(source);
      if (!rec) continue;
      await tx
        .objectStore('outbox')
        .put({ envelope: this.seal(source, rec), base_rev: pending?.base_rev ?? e.rev }, e.id);
      n++;
    }
    await tx.done;
    await this.sync();
    return n;
  }

  /** One sync pass (push, then pull). Concurrent calls coalesce. */
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      syncStatus.value = 'syncing';
      try {
        do {
          this.again = false;
          await this.push();
          await this.pull();
        } while (this.again && !this.stopped);
        syncStatus.value = 'synced';
      } catch (err) {
        syncStatus.value = err instanceof ApiError && err.status === 0 ? 'offline' : 'error';
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async push(): Promise<void> {
    const d = await db();
    for (;;) {
      const ids = (await d.getAllKeys('outbox')).slice(0, MAX_PUSH).map(String);
      if (!ids.length) return;
      const items: OutboxEntry[] = [];
      for (const id of ids) {
        const o = await d.get('outbox', id);
        if (o) items.push(o);
      }
      const res = await api<PushResponse>('/sync/push', {
        body: {
          space_id: this.ctx.spaceId,
          items: items.map((o) => ({ envelope: o.envelope, base_rev: o.base_rev })),
        },
      });
      const remoteUpserts: Entry[] = [];
      const remoteRemoved: string[] = [];
      let stale = false;
      for (const [i, result] of res.results.entries()) {
        const sent = items[i];
        if (!result || !sent) continue;
        const id = sent.envelope.id;
        const current = await d.get('outbox', id);
        const unchanged = current?.envelope.nonce === sent.envelope.nonce;
        if (result.status === 'ok') {
          await d.put(
            'envelopes',
            {
              ...sent.envelope,
              rev: result.rev,
              updated_at: Date.now(),
              updated_by: this.ctx.userId,
            } as Envelope,
            id,
          );
          if (unchanged) await d.delete('outbox', id);
          else if (current) await d.put('outbox', { ...current, base_rev: result.rev }, id);
        } else if (result.status === 'conflict') {
          await this.resolve(id, result.current, current, remoteUpserts, remoteRemoved);
        } else if (result.reason === 'stale_key') {
          // Keys were rotated elsewhere. Keep the change: it is re-sealed
          // once this device has the new keys.
          stale = true;
        } else {
          // Rejected (quota, not allowed): drop it and fall back to the server's copy.
          await d.delete('outbox', id);
          const base = await d.get('envelopes', id);
          const rec = base && this.open(base);
          const entry = base && rec ? this.toEntry(base, rec) : null;
          if (entry) remoteUpserts.push(entry);
          else remoteRemoved.push(id);
        }
      }
      applyRemote(remoteUpserts, remoteRemoved);
      if (stale) {
        needsNewKeys.value = true;
        return;
      }
    }
  }

  /** Merges a server version with whatever this device has for the record. */
  private async resolve(
    id: string,
    remoteEnv: Envelope,
    pending: OutboxEntry | undefined,
    upserts: Entry[],
    removed: string[],
  ): Promise<void> {
    const d = await db();
    const remote = this.open(remoteEnv);
    const baseEnv = await d.get('envelopes', id);
    await d.put('envelopes', remoteEnv, id);
    if (!remote && this.unknownKey(remoteEnv)) {
      // Re-encrypted under keys this device doesn't have yet: keep showing
      // what it has (and any pending change) until the key update arrives.
      needsNewKeys.value = true;
      return;
    }
    if (!remote) {
      if (pending) await d.delete('outbox', id);
      removed.push(id);
      return;
    }
    const local = pending ? this.open(pending.envelope) : baseEnv ? this.open(baseEnv) : null;
    const base = baseEnv ? (this.open(baseEnv) ?? undefined) : undefined;
    const outcome = mergeRecord(base, local ?? undefined, remote, !!pending, {
      now: Date.now(),
      device_id: this.ctx.deviceId,
    });
    if (outcome.action === 'take-remote') {
      if (pending) await d.delete('outbox', id);
    } else {
      const envelope =
        outcome.action === 'merged'
          ? this.seal(remoteEnv, outcome.record)
          : (pending?.envelope ?? this.seal(remoteEnv, outcome.record));
      await d.put('outbox', { envelope, base_rev: remoteEnv.rev }, id);
      this.again = true;
    }
    const entry = this.toEntry(remoteEnv, outcome.record);
    if (entry) upserts.push(entry);
    else removed.push(id);
  }

  private async pull(): Promise<void> {
    const d = await db();
    let since = (await kvGet<number>(this.cursorKey())) ?? 0;
    for (;;) {
      const page = await api<PullResponse>(
        `/sync/pull?space_id=${encodeURIComponent(this.ctx.spaceId)}&since=${since}`,
      );
      const upserts: Entry[] = [];
      const removed: string[] = [];
      for (const env of page.envelopes) {
        const pending = await d.get('outbox', env.id);
        await this.resolve(env.id, env, pending, upserts, removed);
      }
      applyRemote(upserts, removed);
      since = page.cursor;
      await kvSet(this.cursorKey(), since);
      if (!page.more) return;
    }
  }
}
