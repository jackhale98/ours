// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account state and the onboarding flows: sign-in, creating a space and its
 * keys, the recovery phrase and backup, inviting a partner, joining with an
 * invite, and restoring keys on a new device.
 *
 * Every key is generated and used on this device. The server receives only
 * ciphertext: wrapped invites, the backup sealed with the recovery phrase,
 * and encrypted records.
 */
import {
  createDeviceInvite,
  createPartnerInvite,
  createRekeyInvite,
  formatInviteFragment,
  fromBase64Url,
  generateKey,
  KeyRing,
  openBackup,
  openDeviceInvite,
  openPartnerInvite,
  openRekeyInvite,
  parseInviteFragment,
  parseKeyRing,
  recoveryKeyFromPhrase,
  safetyCode,
  sealBackup,
  serializeKeyRing,
  toBase64Url,
} from '@ours/core/crypto';
import { signal } from '@preact/signals';
import type { Slot } from '../app/model';
import { put, settings, store } from '../app/model';
import { HAS_API } from '../config';
import { ApiError, api, setToken } from './api';
import { kvGet, kvSet, wipe } from './db';
import { startFeeds, stopFeeds } from './feeds';
import { loadRing, saveRing } from './keystore';
import { disablePush, startNotifications, stopNotifications, unsubscribeLocally } from './notify';
import { needsNewKeys, SyncEngine } from './sync';

export interface Session {
  token: string;
  user: { id: string; email: string };
  device_id: string;
}

interface MeResponse {
  user: { id: string; email: string; personal_key_version?: number };
  device_id: string;
  devices: { id: string; label: string; created_at: number; last_seen: number | null }[];
  spaces: {
    space_id: string;
    role: Slot;
    members: { user_id: string; role: Slot }[];
    key_version?: number;
    rotated_rev?: number;
  }[];
  passkeys: number;
}

export type AccountState =
  | { status: 'none' } // no account on this device (demo or landing)
  | { status: 'loading' }
  | { status: 'needs-profile'; session: Session } // signed in, no space yet
  | { status: 'needs-keys'; session: Session; spaceId: string; slot: Slot } // space exists, keys not on this device
  | { status: 'ready'; session: Session; spaceId: string; slot: Slot; partnerJoined: boolean };

export const account = signal<AccountState>({ status: HAS_API ? 'loading' : 'none' });
export const me = signal<MeResponse | null>(null);
let engine: SyncEngine | null = null;
let ring: KeyRing | null = null;

const PENDING_INVITE = 'ours-pending-invite';
const COLORS: Record<Slot, string> = { a: '#2b6e8c', b: '#b3486a' };

export function pendingInvite(): string | null {
  try {
    return sessionStorage.getItem(PENDING_INVITE);
  } catch {
    return null;
  }
}
export function setPendingInvite(fragment: string | null): void {
  try {
    if (fragment) sessionStorage.setItem(PENDING_INVITE, fragment);
    else sessionStorage.removeItem(PENDING_INVITE);
  } catch {
    // ignore
  }
}
const pendingInviteId = () => {
  const f = pendingInvite();
  if (!f) return undefined;
  try {
    return parseInviteFragment(f).inviteId;
  } catch {
    return undefined;
  }
};

/* ---------- start-up ---------- */

export async function restore(): Promise<void> {
  if (!HAS_API) {
    account.value = { status: 'none' };
    return;
  }
  const session = await kvGet<Session>('session').catch(() => undefined);
  if (!session) {
    account.value = { status: 'none' };
    return;
  }
  setToken(session.token);
  await refresh(session);
}

/** Works out where this account is in setup and starts sync when ready. */
async function refresh(session: Session): Promise<void> {
  let info: MeResponse;
  try {
    info = await api<MeResponse>('/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await signOut(false);
      return;
    }
    // Offline: carry on from what this device knows.
    const cached = await kvGet<MeResponse>('me');
    if (!cached) throw err;
    info = cached;
  }
  me.value = info;
  await kvSet('me', info);
  const space = info.spaces[0];
  if (!space) {
    account.value = { status: 'needs-profile', session };
    return;
  }
  ring = ring ?? (await loadRing());
  if (!ring || ring.spaceKeys(space.space_id).length === 0) {
    account.value = { status: 'needs-keys', session, spaceId: space.space_id, slot: space.role };
    return;
  }
  // Keys rotated elsewhere (ADR 0013): this device keeps working with what it
  // has, and asks for the key update.
  const latest = (keys: { version: number }[]) => Math.max(0, ...keys.map((k) => k.version));
  const floor = {
    space: space.key_version ?? 1,
    personal: info.user.personal_key_version ?? 1,
    rotatedRev: space.rotated_rev ?? 0,
  };
  needsNewKeys.value =
    latest(ring.spaceKeys(space.space_id)) < floor.space ||
    latest(ring.personalKeys()) < floor.personal;
  if (!engine) {
    engine = new SyncEngine({
      ring,
      userId: session.user.id,
      deviceId: session.device_id,
      spaceId: space.space_id,
      slot: space.role,
      floor,
    });
    await engine.start();
    const e = engine;
    void startNotifications({
      ring,
      spaceId: space.space_id,
      slot: space.role,
      userId: session.user.id,
      partnerId: () =>
        me.value?.spaces
          .find((x) => x.space_id === space.space_id)
          ?.members.find((m) => m.user_id !== session.user.id)?.user_id ?? null,
      synced: () => e.sync(),
    });
    void startFeeds();
  }
  account.value = {
    status: 'ready',
    session,
    spaceId: space.space_id,
    slot: space.role,
    partnerJoined: space.members.length > 1,
  };
}

export const syncNow = () => engine?.sync();

/* ---------- sign-in ---------- */

/**
 * If the address is a magic link (#signin=<token>), reads the token once,
 * removes it from history and signs in. Works on page load and when the link
 * is opened in a tab where the app is already running.
 */
export async function consumeSignInLink(): Promise<'none' | 'ok' | 'failed'> {
  const token = /^#signin=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1];
  if (!token) return 'none';
  history.replaceState(null, '', `${location.pathname}${location.search}#start`);
  try {
    await verifyEmail(token);
    return 'ok';
  } catch {
    return 'failed';
  }
}

export async function startEmail(email: string, acceptTerms: boolean): Promise<void> {
  const invite = pendingInviteId();
  await api('/auth/email/start', {
    auth: false,
    body: { email, accept_terms: acceptTerms, ...(invite ? { invite } : {}) },
  });
}

export async function verifyEmail(token: string): Promise<{ newUser: boolean }> {
  const invite = pendingInviteId();
  const res = await api<Session & { new_user: boolean; expires_at: number }>('/auth/email/verify', {
    auth: false,
    body: { token, device_label: deviceLabel(), ...(invite ? { invite } : {}) },
  });
  const session: Session = { token: res.token, user: res.user, device_id: res.device_id };
  await kvSet('session', session);
  setToken(session.token);
  await refresh(session);
  return { newUser: res.new_user };
}

export async function signInWithPasskey(): Promise<void> {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const opts = await api<{
    challenge_id: string;
    options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
  }>('/auth/passkey/login/options', { auth: false, body: {} });
  const response = await startAuthentication({ optionsJSON: opts.options });
  const res = await api<Session>('/auth/passkey/login/verify', {
    auth: false,
    body: { challenge_id: opts.challenge_id, response, device_label: deviceLabel() },
  });
  const session: Session = { token: res.token, user: res.user, device_id: res.device_id };
  await kvSet('session', session);
  setToken(session.token);
  await refresh(session);
}

export async function addPasskey(): Promise<void> {
  const { startRegistration } = await import('@simplewebauthn/browser');
  const opts = await api<{
    challenge_id: string;
    options: Parameters<typeof startRegistration>[0]['optionsJSON'];
  }>('/auth/passkey/register/options', { body: {} });
  const response = await startRegistration({ optionsJSON: opts.options });
  await api('/auth/passkey/register/verify', {
    body: { challenge_id: opts.challenge_id, response },
  });
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : 'Browser';
  return os;
}

/**
 * Signs out and removes everything from this device. Without the recovery
 * phrase or another device, private data can't come back, so the UI warns first.
 */
export async function signOut(callServer = true): Promise<void> {
  // The push subscription belongs to this device's session: drop it first.
  if (callServer) await disablePush().catch(() => {});
  else await unsubscribeLocally().catch(() => {});
  stopNotifications();
  stopFeeds();
  if (callServer) await api('/auth/logout', { body: {} }).catch(() => {});
  engine?.stop();
  engine = null;
  ring = null;
  setToken(null);
  await wipe();
  me.value = null;
  account.value = { status: 'none' };
}

/* ---------- creating a space ---------- */

/** First person: create the space, the keys and the shared settings. */
export async function createSpace(name: string): Promise<void> {
  const state = account.value;
  if (state.status !== 'needs-profile') throw new Error('Not ready to create a space');
  const { id: spaceId } = await api<{ id: string }>('/spaces', { body: {} });
  const r = new KeyRing(state.session.user.id);
  r.addPersonalKey({ version: 1, key: generateKey() });
  r.addSpaceKey(spaceId, { version: 1, key: generateKey() });
  await saveRing(r);
  ring = r;
  await refresh(state.session);
  put('settings', {
    week_start: 1,
    members: { a: { name, color: COLORS.a, user_id: state.session.user.id } },
  });
}

/** Seals the key ring with the recovery phrase and stores it as the next backup version. */
export async function saveBackup(words: string[]): Promise<void> {
  if (!ring) throw new Error('No keys on this device');
  const rk = recoveryKeyFromPhrase(words);
  let version = 1;
  try {
    version = (await api<{ version: number }>('/keys/backup')).version + 1;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  const sealed = sealBackup(rk, ring, version);
  await api('/keys/backup', {
    method: 'PUT',
    body: {
      version,
      wrapped: { nonce: toBase64Url(sealed.nonce), ciphertext: toBase64Url(sealed.ciphertext) },
    },
  });
}

/** Makes an invite link for the partner. The secret exists only in the link. */
export async function invitePartner(): Promise<string> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) throw new Error('Not ready');
  const name = settings.value.members?.[state.slot]?.name;
  const created = createPartnerInvite({
    space_id: state.spaceId,
    keys: ring.spaceKeys(state.spaceId),
    ...(name ? { inviter_name: name } : {}),
  });
  const res = await api<{ id: string }>('/invites', {
    body: {
      kind: 'partner',
      space_id: state.spaceId,
      wrapped: {
        nonce: toBase64Url(created.wrapped.nonce),
        ciphertext: toBase64Url(created.wrapped.ciphertext),
      },
    },
  });
  return `${new URL('join/', location.href.split('#')[0]).href}#${formatInviteFragment(res.id, created.secret)}`;
}

/** Partner: open the pending invite, join the space and set up keys. Returns the inviter's name. */
export async function acceptInvite(name: string): Promise<string | null> {
  const fragment = pendingInvite();
  const state = account.value;
  if (!fragment || state.status !== 'needs-profile') throw new Error('No invite to accept');
  const { inviteId, secret } = parseInviteFragment(fragment);
  const inv = await api<{ space_id: string; wrapped: { nonce: string; ciphertext: string } }>(
    `/invites/${inviteId}`,
  );
  const payload = openPartnerInvite(secret, inv.space_id, {
    nonce: fromBase64Url(inv.wrapped.nonce),
    ciphertext: fromBase64Url(inv.wrapped.ciphertext),
  });
  await api(`/invites/${inviteId}/accept`, { body: {} });
  const r = new KeyRing(state.session.user.id);
  r.addPersonalKey({ version: 1, key: generateKey() });
  for (const k of payload.keys) r.addSpaceKey(payload.space_id, k);
  await saveRing(r);
  ring = r;
  setPendingInvite(null);
  await refresh(state.session);
  await syncNow();
  // Add myself to the shared settings (merged field-wise with the partner's).
  const members = settings.value.members ?? {};
  const settingsEntry = store.value.entries.find(
    (e) => e.rec.kind === 'settings' && e.scope === 'space',
  );
  put(
    'settings',
    {
      ...settings.value,
      members: { ...members, b: { name, color: COLORS.b, user_id: state.session.user.id } },
    },
    settingsEntry ? { id: settingsEntry.id } : {},
  );
  return payload.inviter_name ?? null;
}

/** New device: restore keys from the recovery phrase. */
export async function restoreFromPhrase(words: string[]): Promise<void> {
  const state = account.value;
  if (state.status !== 'needs-keys') throw new Error('Not needed');
  const backup = await api<{ version: number; wrapped: { nonce: string; ciphertext: string } }>(
    '/keys/backup',
  );
  const r = openBackup(recoveryKeyFromPhrase(words), state.session.user.id, backup.version, {
    nonce: fromBase64Url(backup.wrapped.nonce),
    ciphertext: fromBase64Url(backup.wrapped.ciphertext),
  });
  await saveRing(r);
  ring = r;
  await refresh(state.session);
}

/** Existing device: make a link that hands this device's keys to a new one. */
export async function linkDevice(): Promise<string> {
  if (!ring) throw new Error('No keys');
  const created = createDeviceInvite(ring);
  const res = await api<{ id: string }>('/invites', {
    body: {
      kind: 'device',
      wrapped: {
        nonce: toBase64Url(created.wrapped.nonce),
        ciphertext: toBase64Url(created.wrapped.ciphertext),
      },
    },
  });
  return `${new URL('join/', location.href.split('#')[0]).href}#${formatInviteFragment(res.id, created.secret)}`;
}

/** New device: receive keys from a device link. */
export async function acceptDeviceLink(fragment: string): Promise<void> {
  const state = account.value;
  if (state.status !== 'needs-keys') throw new Error('Not needed');
  const { inviteId, secret } = parseInviteFragment(fragment);
  const inv = await api<{ wrapped: { nonce: string; ciphertext: string } }>(`/invites/${inviteId}`);
  const r = openDeviceInvite(secret, state.session.user.id, {
    nonce: fromBase64Url(inv.wrapped.nonce),
    ciphertext: fromBase64Url(inv.wrapped.ciphertext),
  });
  await api(`/invites/${inviteId}/accept`, { body: {} });
  await saveRing(r);
  ring = r;
  setPendingInvite(null);
  await refresh(state.session);
}

/* ---------- key rotation (ADR 0013) ---------- */

/** Whose action is needed for this device to get the new keys. */
export function newKeysFrom(): 'partner' | 'my-device' | null {
  const info = me.value;
  const space = info?.spaces[0];
  if (!needsNewKeys.value || !info || !space || !ring) return null;
  const mine = Math.max(0, ...ring.personalKeys().map((k) => k.version));
  return mine < (info.user.personal_key_version ?? 1) ? 'my-device' : 'partner';
}

const copyRing = (r: KeyRing) => parseKeyRing(serializeKeyRing(r));

/** Restarts sync with the current ring, re-reading everything this device has stored. */
async function restartSync(session: Session): Promise<void> {
  engine?.stop(true);
  engine = null;
  await refresh(session);
}

/**
 * Secures the space after losing a device: new space and personal keys,
 * old ones decrypt-only, everything re-encrypted. Returns a one-time key
 * update link for the partner (null if there is no partner yet). The caller
 * must then make a new recovery phrase: only a new backup holds the new keys.
 */
export async function rotateKeys(): Promise<string | null> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) throw new Error('Not ready');
  // The server's current minimums decide the new versions (exactly one more).
  const info = await api<MeResponse>('/me');
  const space = info.spaces.find((x) => x.space_id === state.spaceId);
  const spaceFrom = space?.key_version ?? 1;
  const personalFrom = info.user.personal_key_version ?? 1;
  const next = copyRing(ring);
  // A retry after a lost response reuses the keys made the first time.
  if (!next.spaceKeys(state.spaceId).some((k) => k.version === spaceFrom + 1))
    next.addSpaceKey(state.spaceId, { version: spaceFrom + 1, key: generateKey() });
  if (!next.personalKeys().some((k) => k.version === personalFrom + 1))
    next.addPersonalKey({ version: personalFrom + 1, key: generateKey() });
  // Saved before the server raises the minimums, so a crash in between can't
  // leave the space needing keys nobody has.
  const previous = ring;
  await saveRing(next);
  ring = next;
  try {
    await api(`/spaces/${state.spaceId}/rotate`, {
      body: { space_from: spaceFrom, personal_from: personalFrom },
    });
  } catch (err) {
    // Refused: the new keys must not be used. Offline: keep them for a retry.
    if (err instanceof ApiError && err.status >= 400) {
      await saveRing(previous);
      ring = previous;
    }
    throw err;
  }
  await restartSync(state.session);
  await engine?.reencryptAll();
  return state.partnerJoined ? keyUpdateLink() : null;
}

/** A one-time link that gives the partner the current space keys. */
export async function keyUpdateLink(): Promise<string> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) throw new Error('Not ready');
  const created = createRekeyInvite({
    space_id: state.spaceId,
    keys: ring.spaceKeys(state.spaceId),
  });
  const res = await api<{ id: string }>('/invites', {
    body: {
      kind: 'rekey',
      space_id: state.spaceId,
      wrapped: {
        nonce: toBase64Url(created.wrapped.nonce),
        ciphertext: toBase64Url(created.wrapped.ciphertext),
      },
    },
  });
  return `${new URL('join/', location.href.split('#')[0]).href}#${formatInviteFragment(res.id, created.secret)}`;
}

/**
 * A signed-in, set-up device opens a link: a key update from the partner, or
 * a device link from one of my own devices after they rotated. Adds the keys
 * and re-reads everything. Returns which kind it was.
 */
export async function applyKeyLink(fragment: string): Promise<'rekey' | 'device'> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) throw new Error('Not ready');
  const { inviteId, secret } = parseInviteFragment(fragment);
  const inv = await api<{
    kind: 'partner' | 'device' | 'rekey';
    space_id: string | null;
    wrapped: { nonce: string; ciphertext: string };
  }>(`/invites/${inviteId}`);
  const wrapped = {
    nonce: fromBase64Url(inv.wrapped.nonce),
    ciphertext: fromBase64Url(inv.wrapped.ciphertext),
  };
  const next = copyRing(ring);
  if (inv.kind === 'rekey' && inv.space_id === state.spaceId) {
    const payload = openRekeyInvite(secret, state.spaceId, wrapped);
    const have = new Set(next.spaceKeys(state.spaceId).map((k) => k.version));
    for (const k of payload.keys) if (!have.has(k.version)) next.addSpaceKey(state.spaceId, k);
  } else if (inv.kind === 'device') {
    next.mergeFrom(openDeviceInvite(secret, state.session.user.id, wrapped));
  } else {
    throw new Error('That link isn’t a key update for this space.');
  }
  await api(`/invites/${inviteId}/accept`, { body: {} });
  await saveRing(next);
  ring = next;
  setPendingInvite(null);
  await restartSync(state.session);
  return inv.kind;
}

/** Checks whether the partner has joined (polled while showing the invite). */
export async function checkPartner(): Promise<boolean> {
  const state = account.value;
  if (state.status !== 'ready') return false;
  await refresh(state.session);
  const now = account.value;
  return now.status === 'ready' && now.partnerJoined;
}

/** The safety code for the current space key, or null. */
export function currentSafetyCode(): string | null {
  const state = account.value;
  if (state.status !== 'ready' || !ring) return null;
  const k = ring.currentSpaceKey(state.spaceId);
  return safetyCode(state.spaceId, k.version, k.key);
}
