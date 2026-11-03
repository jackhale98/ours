// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Local record store for the app, currently backed by demo data.
 *
 * Records are the same DecodedRecord shapes that sync encrypts. Every write
 * goes through `sealDecodedRecord` with a local key ring, so the schema and
 * the private-content scope rules are enforced exactly as they will be when
 * records are encrypted and synced. Visibility mirrors a real device:
 * user-scope records are only visible to their owner, and a partner's
 * private event appears only as its shared busy_stub.
 */
import { fromBase64Url, generateKey, scopeAllows, toBase64Url } from '@ours/core/crypto';
import { type DecodedRecord, encodeRecord, type KindData, uuidv7 } from '@ours/core/schema';
import { nextTimestamp } from '@ours/core/sync';
import { batch, computed, signal } from '@preact/signals';

export type Slot = 'a' | 'b';
export type Scope = 'space' | 'user';
type LiveRecord = Extract<DecodedRecord, { deleted: false }>;
export type LiveOf<K extends keyof KindData> = Extract<LiveRecord, { kind: K }>;

export interface Entry {
  id: string;
  scope: Scope;
  /** Owning slot for user-scope records; null for shared ones. */
  owner: Slot | null;
  rec: LiveRecord;
}

export interface StoreData {
  v: 2;
  viewer: Slot;
  /** Base64url demo space key, kept so the safety code is stable. */
  space_key: string;
  entries: Entry[];
}

export const SPACE_ID = 'demo-space';
const STORAGE_KEY = 'ours-demo-v2';

export const other = (s: Slot): Slot => (s === 'a' ? 'b' : 'a');

/* ---------- state ---------- */

function load(): StoreData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as StoreData;
    return data && data.v === 2 && Array.isArray(data.entries) ? data : null;
  } catch {
    return null;
  }
}

export const store = signal<StoreData>(
  load() ?? { v: 2, viewer: 'a', space_key: toBase64Url(generateKey()), entries: [] },
);

/* ---------- backend ---------- */

/**
 * Where writes go. The demo keeps plaintext sample data in localStorage; a
 * signed-in account encrypts each write into the outbox and syncs it
 * (src/account/sync.ts).
 */
export interface Backend {
  mode: 'demo' | 'account';
  /** Authenticated write metadata: which device wrote it. */
  deviceId(author: Slot): string;
  /** Local changes to persist (and, for accounts, encrypt and sync). */
  write(upserts: Entry[], removed: Entry[]): void;
}

const demoBackend: Backend = {
  mode: 'demo',
  deviceId: (author) => `demo-${author}`,
  write: () => persist(),
};

let backend: Backend = demoBackend;
export const mode = signal<'demo' | 'account'>('demo');

export function setBackend(b: Backend | null): void {
  backend = b ?? demoBackend;
  mode.value = backend.mode;
}

/** Latest write time per removed id, so an undo outranks its own deletion. */
const removedAt = new Map<string, number>();

let persistPaused = false;

/** Runs many writes as one: a single re-render and a single save. */
export function bulk(fn: () => void): void {
  persistPaused = true;
  try {
    batch(fn);
  } finally {
    persistPaused = false;
    persist();
  }
}

export function persist(): void {
  if (persistPaused || backend.mode !== 'demo') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.value));
  } catch {
    // Private mode or storage full: the demo keeps working in memory.
  }
}

export const viewer = computed(() => store.value.viewer);
export const partner = computed(() => other(store.value.viewer));

/** Entries this device can decrypt and should show. */
export const visible = computed(() => {
  const me = store.value.viewer;
  return store.value.entries.filter((e) => {
    if (e.scope === 'user') return e.owner === me;
    // My own private events are shown in full, so hide their shared stubs.
    if (e.rec.kind === 'busy_stub') return e.rec.data.owner !== me;
    return true;
  });
});

export function byKind<K extends keyof KindData>(kind: K): Entry[] {
  return visible.value.filter((e) => e.rec.kind === kind);
}

export function findEntry(id: string): Entry | undefined {
  return store.value.entries.find((e) => e.id === id);
}

/* ---------- keys ---------- */

export function spaceKey(): Uint8Array {
  return fromBase64Url(store.value.space_key);
}

/* ---------- writes ---------- */

type Data<K extends keyof KindData> = KindData[K];

/**
 * Creates or replaces a record. Throws (RecordError / CryptoError) if the
 * data is invalid or the content is not allowed in the scope.
 */
export function put<K extends keyof KindData>(
  kind: K,
  data: Data<K>,
  opts: { id?: string; scope?: Scope; owner?: Slot | null } = {},
): string {
  const id = opts.id ?? uuidv7();
  const prev = findEntry(id);
  const scope = opts.scope ?? prev?.scope ?? 'space';
  const author = store.value.viewer;
  const owner = scope === 'user' ? (opts.owner ?? prev?.owner ?? author) : null;
  const rec = {
    kind,
    deleted: false,
    data,
    updated_at: nextTimestamp(Date.now(), prev?.rec.updated_at ?? removedAt.get(id)),
    device_id: backend.deviceId(author),
  } as LiveRecord;
  // Same checks as a real encrypted write: schema validation and the
  // private-content scope policy (sealDecodedRecord runs these, then encrypts).
  if (!scopeAllows(rec, scope)) throw new Error('Record content not allowed in this scope');
  encodeRecord(rec);
  const entry: Entry = { id, scope, owner, rec };
  const entries = prev
    ? store.value.entries.map((e) => (e.id === id ? entry : e))
    : [...store.value.entries, entry];
  store.value = { ...store.value, entries };
  backend.write([entry], []);
  return id;
}

export function update<K extends keyof KindData>(id: string, patch: Partial<Data<K>>): void {
  const e = findEntry(id);
  if (!e) return;
  put(e.rec.kind as K, { ...(e.rec.data as Data<K>), ...patch }, { id });
}

/** Removes records and returns a function that restores them (for undo). */
export function remove(ids: string[]): () => void {
  const gone = store.value.entries.filter((e) => ids.includes(e.id));
  for (const e of gone) removedAt.set(e.id, nextTimestamp(Date.now(), e.rec.updated_at));
  store.value = { ...store.value, entries: store.value.entries.filter((e) => !ids.includes(e.id)) };
  backend.write([], gone);
  return () => {
    const have = new Set(store.value.entries.map((e) => e.id));
    // Restoring is a new write, stamped after the deletion so it wins everywhere.
    const back = gone
      .filter((e) => !have.has(e.id))
      .map((e) => ({
        ...e,
        rec: {
          ...e.rec,
          updated_at: nextTimestamp(Date.now(), removedAt.get(e.id)),
          device_id: backend.deviceId(store.value.viewer),
        },
      }));
    store.value = { ...store.value, entries: [...store.value.entries, ...back] };
    backend.write(back, []);
  };
}

/**
 * Applies changes that arrived from sync. Does not write back.
 * `upserts` replace entries with the same id; `removedIds` disappear.
 */
export function applyRemote(upserts: Entry[], removedIds: string[] = []): void {
  if (!upserts.length && !removedIds.length) return;
  const byId = new Map(store.value.entries.map((e) => [e.id, e]));
  for (const id of removedIds) byId.delete(id);
  for (const e of upserts) byId.set(e.id, e);
  store.value = { ...store.value, entries: [...byId.values()] };
}

/** Replaces the whole store (account load, demo reset). */
export function loadEntries(viewerSlot: Slot, entries: Entry[]): void {
  store.value = { v: 2, viewer: viewerSlot, space_key: store.value.space_key, entries };
}

export function setViewer(slot: Slot): void {
  if (backend.mode !== 'demo') return; // a real device is always its owner
  store.value = { ...store.value, viewer: slot };
  persist();
}

export function replaceAll(data: StoreData): void {
  store.value = data;
  persist();
}

/* ---------- domain operations ---------- */

export type EventData = Data<'event'>;

/** Comments attached to a record. */
export function commentsFor(parentId: string): Entry[] {
  return byKind('comment').filter(
    (c) => c.rec.kind === 'comment' && c.rec.data.parent_id === parentId,
  );
}

/**
 * Creates an event. Private ("busy-only") events are written as a full
 * record under the owner's personal key plus a shared busy stub.
 */
export function createEvent(data: EventData): string {
  if (data.privacy !== 'busy') return put('event', { ...data, stub_id: null });
  const stubId = uuidv7();
  const id = put('event', { ...data, stub_id: stubId }, { scope: 'user' });
  put(
    'busy_stub',
    {
      start: data.start,
      end: data.end,
      all_day: data.all_day,
      tz: data.tz,
      rrule: data.rrule,
      away: data.away,
      owner: data.owner === 'b' ? 'b' : 'a',
    },
    { id: stubId },
  );
  return id;
}

/** Deletes an event with its stub and comments. Returns undo. */
export function deleteEvent(id: string): () => void {
  const e = findEntry(id);
  if (e?.rec.kind !== 'event') return () => {};
  const ids = [id, ...commentsFor(id).map((c) => c.id)];
  if (e.rec.data.stub_id) ids.push(e.rec.data.stub_id);
  return remove(ids);
}

/**
 * Switching privacy changes the record's scope, which changes its key and
 * AAD, so the event is re-created under a new id and its comments move with it.
 */
export function setEventPrivacy(id: string, busy: boolean): string {
  const e = findEntry(id);
  if (e?.rec.kind !== 'event') return id;
  const data = e.rec.data;
  if ((data.privacy === 'busy') === busy) return id;
  const comments = commentsFor(id).map((c) => c.rec.data as Data<'comment'>);
  deleteEvent(id);
  const newId = createEvent({ ...data, privacy: busy ? 'busy' : 'full' });
  for (const c of comments) {
    put('comment', { ...c, parent_id: newId }, { scope: busy ? 'user' : 'space' });
  }
  return newId;
}

export function addComment(parentId: string, text: string): void {
  const parent = findEntry(parentId);
  put(
    'comment',
    { parent_id: parentId, text, author: store.value.viewer },
    { scope: parent?.scope ?? 'space' },
  );
}

/* ---------- settings ---------- */

export const settings = computed<Data<'settings'>>(() => {
  const s = visible.value.find((e) => e.rec.kind === 'settings' && e.scope === 'space');
  return s && s.rec.kind === 'settings' ? s.rec.data : {};
});

export const names = computed(() => ({
  a: settings.value.members?.a?.name ?? 'Partner A',
  b: settings.value.members?.b?.name ?? 'Partner B',
}));

export function nameOf(slot: Slot): string {
  return names.value[slot];
}
