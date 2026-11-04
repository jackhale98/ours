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
  generateRecoveryPhrase,
  KeyRing,
  keyId,
  openBackup,
  openDeviceInvite,
  openPartnerInvite,
  openRekeyInvite,
  openUnlock,
  parseInviteFragment,
  recoveryKeyFromPhrase,
  safetyCode,
  sealBackup,
  sealUnlock,
  toBase64Url,
  UNLOCK_SALT,
} from '@ours/core/crypto';
import { signal } from '@preact/signals';
import type { Slot } from '../app/model';
import { put, settings, store, updateSettings } from '../app/model';
import { HAS_API } from '../config';
import { ApiError, api, setToken } from './api';
import { db, kvGet, kvSet, wipe } from './db';
import { feedOn, newFeedLink, setPartnerPresent, startFeeds, stopFeeds } from './feeds';
import { dropStaged, loadRing, saveRing } from './keystore';
import {
  disablePush,
  forgetReminders,
  startNotifications,
  stopNotifications,
  unsubscribeLocally,
} from './notify';
import { userVerified } from './passkeys';
import {
  activeRing,
  copyRing,
  dropUnconfirmed,
  type Floor,
  KeyLinkError,
  type KeyState,
  type Kid,
  mergeFloor,
  refusal,
  stagedAction,
  stagedOutcome,
  takeKeys,
} from './rotation';
import { needsNewKeys, SyncEngine } from './sync';

export interface Session {
  token: string;
  user: { id: string; email: string };
  device_id: string;
}

interface MeResponse {
  user: {
    id: string;
    email: string;
    personal_key_version?: number;
    personal_kids?: Kid[];
    /** When this person last changed keys (rotation), if ever. */
    keys_changed_at?: number | null;
  };
  device_id: string;
  /** When this session signed in or last confirmed with a passkey. */
  signed_in_at?: number;
  /** Whether passkeys may be set up to unlock keys (ADR 0015). */
  passkey_unlock?: boolean;
  devices: { id: string; label: string; created_at: number; last_seen: number | null }[];
  spaces: {
    space_id: string;
    role: Slot;
    members: { user_id: string; role: Slot; key_version?: number }[];
    key_version?: number;
    rotated_rev?: number;
    rotated_by?: string | null;
    rotated_at?: number | null;
    kids?: Kid[];
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

/**
 * An opened invite or device link, kept in this tab until it's used. When a
 * sign-in link is asked for, it's also kept on the device for that email
 * address, because the email's link often opens in a new tab or the browser
 * instead of the installed app: kept per tab only, the invite was lost and
 * the partner made a space of their own (ADR 0016). After signing in it's
 * kept only if that's the address signed in with, and only in that tab; it's
 * dropped after a day (invites expire on the server within one) and at sign
 * out, so on a shared browser it doesn't reach someone else (review 0007, M3).
 */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
interface KeptInvite {
  fragment: string;
  at: number;
  email: string;
}
function keptInvite(): KeptInvite | null {
  try {
    const raw = localStorage.getItem(PENDING_INVITE);
    if (!raw) return null;
    const k = JSON.parse(raw) as Partial<KeptInvite>;
    if (
      typeof k.fragment === 'string' &&
      typeof k.email === 'string' &&
      typeof k.at === 'number' &&
      Date.now() - k.at < PENDING_TTL_MS
    )
      return k as KeptInvite;
    localStorage.removeItem(PENDING_INVITE);
  } catch {
    // Storage blocked.
  }
  return null;
}
/** This tab's invite. One kept for a sign-in link comes back only after signing in with that address. */
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
  try {
    if (!fragment) localStorage.removeItem(PENDING_INVITE);
  } catch {
    // ignore
  }
}
/** Keeps this tab's invite on the device for the sign-in link asked for with this address. */
function keepInviteFor(email: string): void {
  const fragment = pendingInvite();
  if (!fragment) return;
  try {
    localStorage.setItem(
      PENDING_INVITE,
      JSON.stringify({ fragment, at: Date.now(), email: email.trim().toLowerCase() }),
    );
  } catch {
    // Private mode: kept in this tab only.
  }
}
/** Signed in: the kept invite stays (in this tab only) if it was kept for this address. */
function claimKeptInvite(email: string): void {
  const kept = keptInvite();
  try {
    localStorage.removeItem(PENDING_INVITE);
  } catch {
    // ignore
  }
  try {
    if (kept && kept.email === email.trim().toLowerCase())
      sessionStorage.setItem(PENDING_INVITE, kept.fragment);
    // Kept for someone else: not this person's, in this tab either (review 0007, C1).
    else if (kept && sessionStorage.getItem(PENDING_INVITE) === kept.fragment)
      sessionStorage.removeItem(PENDING_INVITE);
  } catch {
    // ignore
  }
}
/**
 * The invite's id (not its secret) for sign-up when sign-ups need an invite.
 * A kept one counts here, before signing in, since the email link may open
 * in another tab; its secret stays put unless the address matches.
 */
const pendingInviteId = () => {
  const f = pendingInvite() ?? keptInvite()?.fragment;
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
  let fresh = true;
  try {
    info = await api<MeResponse>('/me');
  } catch (err) {
    fresh = false;
    if (err instanceof ApiError && err.status === 401) {
      await signOut(false);
      return;
    }
    // Offline: carry on from what this device knows.
    const cached = await kvGet<MeResponse>('me');
    if (!cached) throw err;
    info = cached;
  }
  // A join with this account (ADR 0016) whose answer this device didn't get:
  // the server says whether it happened (review 0007, H1 and M1).
  const joining = fresh ? await kvGet<Joining>('joining') : undefined;
  let joinedNow: Joining | null = null;
  if (joining) {
    if (info.spaces.some((x) => x.space_id === joining.space)) joinedNow = joining;
    else {
      // It didn't happen: drop the keys it brought.
      ring = ring ?? (await loadRing());
      if (ring && joining.space !== info.spaces[0]?.space_id) {
        ring.removeSpace(joining.space);
        await saveRing(ring);
      }
      await kvSet('joining', null);
    }
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
  // Keys rotated (ADR 0013, review 0005): what this device trusts only ever
  // moves forward, a rotation whose answer was lost is picked up, keys that
  // never became real are dropped, and only keys whose fingerprints match
  // the server's are used. Without the current ones this device keeps
  // working with what it has, and asks for the key update.
  const floor = await learnFloor(space.space_id, {
    space: space.key_version ?? 1,
    personal: info.user.personal_key_version ?? 1,
    rotatedRev: space.rotated_rev ?? 0,
  });
  await settleStaged(info, space.space_id, floor, fresh);
  if (dropUnconfirmed(ring, space.space_id, floor)) await saveRing(ring);
  const kids = { space: space.kids ?? [], personal: info.user.personal_kids ?? [] };
  const active = activeRing(ring, space.space_id, floor, kids);
  needsNewKeys.value = active.space !== 'ok' || active.personal !== 'ok';
  keyState.value = { space: active.space, personal: active.personal };
  rotation.value = (await kvGet<RotationState>(rotationKey(space.space_id))) ?? null;
  phraseStale.value = !!(await kvGet<boolean>('phrase-stale'));
  phraseKept.value = !!(await kvGet<boolean>('phrase-kept'));
  void acknowledgeKeys(info, space.space_id, floor, active.space);
  if (joinedNow) await afterJoin(joinedNow);
  if (!engine) {
    // Anything kept here for another space (this account joined a partner,
    // here or on another device) goes, unsent writes included: the server
    // refuses a push that mixes spaces, so they'd block syncing for good
    // (review 0007, L2 and C5).
    await dropOtherSpaces(space.space_id);
    engine = new SyncEngine({
      ring: active.ring,
      userId: session.user.id,
      deviceId: session.device_id,
      spaceId: space.space_id,
      slot: space.role,
      floor,
    });
    await engine.start();
    const e = engine;
    void startNotifications({
      ring: active.ring,
      spaceId: space.space_id,
      slot: space.role,
      userId: session.user.id,
      partnerId: () =>
        me.value?.spaces
          .find((x) => x.space_id === space.space_id)
          ?.members.find((m) => m.user_id !== session.user.id)?.user_id ?? null,
      synced: () => e.sync(),
    });
    void startFeeds()
      .then(replaceFeedIfAsked)
      .catch(() => {});
  }
  account.value = {
    status: 'ready',
    session,
    spaceId: space.space_id,
    slot: space.role,
    partnerJoined: space.members.length > 1,
  };
  if (joinedNow) {
    // Into the shared settings, then a new phrase and the safety code.
    await syncNow()?.catch(() => {});
    joinSettings(joinedNow.name, session.user.id);
    // Kept until the safety code is compared, so a reload doesn't skip it (C3).
    await kvSet('joined-flow', true);
    await kvSet('joining', null);
  }
  if (await kvGet<boolean>('joined-flow')) joinedWithAccount.value = true;
  setPartnerPresent(space.members.length > 1);
  void keepStorage();
  // A rotation that was made but didn't finish re-encrypting carries on.
  if (rotation.value?.stage === 'securing') void finishSecuring();
}

/**
 * Asks the browser to keep this site's storage, which holds the keys, when
 * the device runs low on space. Without it, a browser may clear it like a
 * cache, and the next visit asks for a device link or the recovery phrase.
 * Browsers decide for themselves (some grant it at once, some after use, an
 * installed app usually always); asking is harmless either way.
 */
async function keepStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    // Not supported here: nothing to do.
  }
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

export async function startEmail(
  email: string,
  acceptTerms: boolean,
  turnstile?: string,
): Promise<void> {
  const invite = pendingInviteId();
  keepInviteFor(email);
  await api('/auth/email/start', {
    auth: false,
    body: {
      email,
      accept_terms: acceptTerms,
      ...(invite ? { invite } : {}),
      ...(turnstile ? { turnstile } : {}),
    },
  });
}

export async function verifyEmail(token: string): Promise<{ newUser: boolean }> {
  const invite = pendingInviteId();
  const res = await api<Session & { new_user: boolean; expires_at: number }>('/auth/email/verify', {
    auth: false,
    body: { token, device_label: deviceLabel(), ...(invite ? { invite } : {}) },
  });
  const session: Session = { token: res.token, user: res.user, device_id: res.device_id };
  claimKeptInvite(res.user.email);
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
  // The same touch can unlock this account's keys, if the passkey was set up
  // for it (ADR 0015): ask the passkey for its unlock secret too.
  const response = await startAuthentication({
    optionsJSON: { ...opts.options, extensions: { ...opts.options.extensions, ...prfRequest() } },
  });
  const prf = takePrf(response.clientExtensionResults);
  // Used only if the person was verified (face, fingerprint or passcode), not
  // just present: some providers skip it when asked nicely (review 0006, M2).
  const verified = userVerified(fromBase64Url(response.response.authenticatorData));
  try {
    const res = await api<Session>('/auth/passkey/login/verify', {
      auth: false,
      body: { challenge_id: opts.challenge_id, response, device_label: deviceLabel() },
    });
    const session: Session = { token: res.token, user: res.user, device_id: res.device_id };
    await kvSet('session', session);
    setToken(session.token);
    await refresh(session);
    if (prf && verified && me.value?.passkey_unlock && account.value.status === 'needs-keys')
      await unlockWith(response.id, prf).catch(() => {
        // Not set up for this passkey: the Welcome back screen offers the rest.
      });
  } finally {
    prf?.fill(0);
  }
}

export async function addPasskey(): Promise<void> {
  const { startRegistration } = await import('@simplewebauthn/browser');
  const opts = await api<{
    challenge_id: string;
    options: Parameters<typeof startRegistration>[0]['optionsJSON'];
  }>('/auth/passkey/register/options', { body: {} });
  // Made able to unlock keys later (ADR 0015): some passkeys, like security
  // keys, only answer PRF requests if asked for it when they're created.
  const response = await startRegistration({
    optionsJSON: {
      ...opts.options,
      extensions: { ...opts.options.extensions, prf: {} } as NonNullable<
        typeof opts.options.extensions
      >,
    },
  });
  // Whether its app can give an unlock secret, so the list can say which
  // passkeys can unlock. Only that yes or no is sent: never any secret.
  const results = response.clientExtensionResults as { prf?: { enabled?: unknown } };
  const enabled = results.prf?.enabled;
  takePrf(results);
  await api('/auth/passkey/register/verify', {
    body: {
      challenge_id: opts.challenge_id,
      response,
      ...(typeof enabled === 'boolean' ? { prf_enabled: enabled } : {}),
    },
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
  setPendingInvite(null);
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

/**
 * Seals a key ring (this device's, unless given) with the recovery phrase and
 * stores it as the next backup version.
 */
export async function saveBackup(words: string[], over: KeyRing | null = ring): Promise<void> {
  if (!over) throw new Error('No keys on this device');
  const rk = recoveryKeyFromPhrase(words);
  let version = 1;
  try {
    version = (await api<{ version: number }>('/keys/backup')).version + 1;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  const sealed = sealBackup(rk, over, version);
  await api('/keys/backup', {
    method: 'PUT',
    body: {
      version,
      wrapped: { nonce: toBase64Url(sealed.nonce), ciphertext: toBase64Url(sealed.ciphertext) },
    },
  });
  // A backup over this device's own ring holds every key it uses now.
  if (over === ring) {
    phraseStale.value = false;
    await kvSet('phrase-stale', false);
  }
}

/** Whether these words open this account's current backup (checked before an encrypted export). */
export async function isCurrentPhrase(words: (string | null)[]): Promise<boolean> {
  const state = account.value;
  if (state.status !== 'ready') return false;
  try {
    const backup = await api<{ version: number; wrapped: { nonce: string; ciphertext: string } }>(
      '/keys/backup',
    );
    openBackup(recoveryKeyFromPhrase(words), state.session.user.id, backup.version, {
      nonce: fromBase64Url(backup.wrapped.nonce),
      ciphertext: fromBase64Url(backup.wrapped.ciphertext),
    });
    return true;
  } catch {
    return false;
  }
}

/** Makes an invite link for the partner. The secret exists only in the link. */
export async function invitePartner(): Promise<string> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) throw new Error('Not ready');
  const name = settings.value.members?.[state.slot]?.name;
  // Whoever joins next starts unasked: a former partner's feed consent
  // doesn't pass to them (review 0004 re-check, N5).
  const other = state.slot === 'a' ? 'b' : 'a';
  const shares = settings.value.feed_share_busy;
  if (shares?.[other]) updateSettings({ feed_share_busy: { ...shares, [other]: false } });
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
  joinSettings(name, state.session.user.id);
  return payload.inviter_name ?? null;
}

/** Adds the joiner to the shared settings (merged field-wise with the partner's). */
function joinSettings(name: string, userId: string): void {
  const members = settings.value.members ?? {};
  const settingsEntry = store.value.entries.find(
    (e) => e.rec.kind === 'settings' && e.scope === 'space',
  );
  put(
    'settings',
    {
      ...settings.value,
      members: { ...members, b: { name, color: COLORS.b, user_id: userId } },
      // Joining doesn't agree to anything a former partner had agreed to (N5).
      feed_share_busy: { ...settings.value.feed_share_busy, b: false },
    },
    settingsEntry ? { id: settingsEntry.id } : {},
  );
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

/* ---------- key rotation (ADR 0013, review 0005) ---------- */

/**
 * Where a rotation stands, kept on this device so it can carry on after a
 * reload or a lost answer (review 0005, H2 and M2):
 * - staged: new keys made and kept apart (never used to seal anything);
 *   `backup` once the new phrase's backup holds them;
 * - securing: the server made them current; re-encrypting what's left.
 */
export type RotationState =
  | {
      stage: 'staged';
      spaceFrom: number;
      personalFrom: number;
      /** The new phrase's backup is saved (or `tried`: it may have been). */
      backup: boolean;
      tried?: boolean;
    }
  | { stage: 'securing'; version: number };

export const rotation = signal<RotationState | null>(null);
/** Live records still under old keys, as the server counts them (M2). */
export const rotationLeft = signal<{ space: number; mine: number } | null>(null);
/** Whether this device holds the current keys, and if not, why. */
export const keyState = signal<{ space: KeyState; personal: KeyState }>({
  space: 'ok',
  personal: 'ok',
});
/** The recovery phrase's backup lacks keys this device now uses (M3). */
export const phraseStale = signal(false);
/** The space key version both people last confirmed comparing safety codes for (I3). */
export const comparedVersion = signal(1);
/**
 * The new phrase's backup was saved but the rotation didn't happen: that
 * phrase is now the one that restores this account (re-review N4).
 */
export const phraseKept = signal(false);
/** A calendar feed link made to replace one a lost phone may follow (L7). */
export const replacedFeed = signal<string | null>(null);

const rotationKey = (spaceId: string) => `rotation:${spaceId}`;
const floorKey = (spaceId: string) => `floor:${spaceId}`;
const comparedKey = (spaceId: string) => `compared:${spaceId}`;
const REKEY_WINDOW_MS = 14 * 86_400_000;

async function setRotation(spaceId: string, state: RotationState | null): Promise<void> {
  rotation.value = state;
  await kvSet(rotationKey(spaceId), state);
}

/** Merges the server's floor into the one this device keeps, and stores it (M6). */
async function learnFloor(
  spaceId: string,
  server: { space: number; personal: number; rotatedRev: number },
): Promise<Floor> {
  const prev = await kvGet<Floor>(floorKey(spaceId));
  const next = mergeFloor(prev, server);
  if (JSON.stringify(prev) !== JSON.stringify(next)) await kvSet(floorKey(spaceId), next);
  comparedVersion.value = (await kvGet<number>(comparedKey(spaceId))) ?? 1;
  return next;
}

/** Whose action is needed for this device to get the new keys. */
export function newKeysFrom(): 'partner' | 'my-device' | null {
  if (!needsNewKeys.value) return null;
  return keyState.value.personal !== 'ok' ? 'my-device' : 'partner';
}

/** Restarts sync with the current ring, re-reading everything this device has stored. */
async function restartSync(session: Session): Promise<void> {
  engine?.stop(true);
  engine = null;
  await refresh(session);
}

const newestOf = (
  staged: KeyRing,
  spaceId: string,
  st: { spaceFrom: number; personalFrom: number },
) => ({
  space: staged.spaceKeys(spaceId).find((k) => k.version === st.spaceFrom + 1),
  personal: staged.personalKeys().find((k) => k.version === st.personalFrom + 1),
});

/**
 * A rotation whose keys were made here but whose answer never came back
 * (H1): if the server's fingerprints show it landed, the keys join the ring;
 * if the versions moved on without it, or no backup was made yet, they're
 * dropped; otherwise they wait for "Try again".
 */
async function settleStaged(
  info: MeResponse,
  spaceId: string,
  floor: Floor,
  fresh: boolean,
): Promise<void> {
  const st = await kvGet<RotationState>(rotationKey(spaceId));
  if (st?.stage !== 'staged' || !ring) return;
  const staged = await loadRing('staged');
  const space = info.spaces.find((x) => x.space_id === spaceId);
  const outcome = staged
    ? stagedOutcome(staged, spaceId, st, {
        space: floor.space,
        personal: floor.personal,
        spaceKids: space?.kids ?? [],
        personalKids: info.user.personal_kids ?? [],
      })
    : 'drop';
  const action = staged ? stagedAction(st, outcome, fresh) : 'drop';
  if (staged && action === 'commit') {
    await commitStaged(staged, spaceId, st, space?.rotated_rev ?? 0);
    // The engine running now seals under the old keys: start a new one (N2).
    if (engine) {
      engine.stop(true);
      engine = null;
    }
    return;
  }
  // Dropped only on a fresh answer: another rotation won, or the new backup
  // was never confirmed (the person is told if it may exist, R3).
  if (action === 'drop') await dropRotation(spaceId, st);
}

/** Forgets a rotation that didn't happen, saying so if its phrase is now the one (N4). */
async function dropRotation(spaceId: string, st: { backup: boolean; tried?: boolean }) {
  await dropStaged();
  await setRotation(spaceId, null);
  if (st.backup || st.tried) {
    phraseKept.value = true;
    await kvSet('phrase-kept', true);
  }
}

export async function dismissPhraseKept(): Promise<void> {
  phraseKept.value = false;
  await kvSet('phrase-kept', false);
}

/** The server confirmed: the new keys join the ring and are used from now on. */
async function commitStaged(
  staged: KeyRing,
  spaceId: string,
  st: { spaceFrom: number; personalFrom: number },
  rotatedRev: number,
): Promise<void> {
  if (!ring) return;
  const next = copyRing(ring);
  next.mergeFrom(staged);
  await saveRing(next);
  ring = next;
  await dropStaged();
  // Never lower than a floor learned since (re-review 2, Info).
  const floor = mergeFloor(await kvGet<Floor>(floorKey(spaceId)), {
    space: st.spaceFrom + 1,
    personal: st.personalFrom + 1,
    rotatedRev,
  });
  await kvSet(floorKey(spaceId), floor);
  await setRotation(spaceId, { stage: 'securing', version: floor.space });
  // The server dropped reminders sealed under the old key: send them again (L2).
  await forgetReminders();
  // And every passkey unlock (ADR 0015): they're set up again on purpose.
  await kvSet('unlocks-made', {});
  unlocksMadeHere.value = {};
  passkeyUnlocks.value = [];
  // The backup was made over these keys before the server moved.
  phraseStale.value = false;
  await kvSet('phrase-stale', false);
  // A lost phone may follow the busy feed: its link is replaced once the
  // feed's state is known, at this start or the next (L7).
  await kvSet('replace-feed', true);
}

/** Replaces the feed link after a rotation, if the feed is on (L7). */
async function replaceFeedIfAsked(): Promise<void> {
  if (!(await kvGet<boolean>('replace-feed'))) return;
  if (feedOn.value) replacedFeed.value = await newFeedLink();
  await kvSet('replace-feed', false);
}

/** Why this device can't start a rotation now, or null if it can. */
export function rotationBlocked(): string | null {
  const state = account.value;
  const info = me.value;
  if (state.status !== 'ready' || !ring || !info) return 'Not ready yet.';
  // A device missing keys would leave gaps in the new ring (L3).
  if (needsNewKeys.value) return 'This device needs the current keys before it can make new ones.';
  if (info.spaces.length > 1) return 'Leave your other spaces before changing keys.';
  if (rotation.value?.stage === 'securing') return 'Still re-encrypting from the last change.';
  return null;
}

/** True when changing keys needs a fresh passkey check first (M4). */
export function needsConfirm(): boolean {
  const info = me.value;
  return !!info && info.passkeys > 0 && Date.now() - (info.signed_in_at ?? 0) > 9 * 60_000;
}

/** Confirms it's you with a passkey, in this session (no new device or sign-in). */
export async function confirmItsYou(): Promise<void> {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const opts = await api<{
    challenge_id: string;
    options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
  }>('/auth/passkey/reauth/options', { body: {} });
  const response = await startAuthentication({ optionsJSON: opts.options });
  await api('/auth/passkey/reauth/verify', {
    body: { challenge_id: opts.challenge_id, response },
  });
  if (me.value) me.value = { ...me.value, signed_in_at: Date.now() };
}

/**
 * Step 1 (H2, M2): once this device has fully synced, make the new keys
 * (kept apart, unused) and a new recovery phrase. Nothing changes on the
 * server yet, and nothing is sealed under the new keys.
 */
export async function prepareRotation(): Promise<string[]> {
  const blocked = rotationBlocked();
  if (blocked) throw new Error(blocked);
  const state = account.value;
  if (state.status !== 'ready') throw new Error('Not ready yet.');
  if (!(await engine?.settle()))
    throw new Error('Finish syncing first: this device needs to be online and up to date.');
  const info = await api<MeResponse>('/me');
  me.value = info;
  const space = info.spaces.find((x) => x.space_id === state.spaceId);
  const spaceFrom = space?.key_version ?? 1;
  const personalFrom = info.user.personal_key_version ?? 1;
  // Checked again against the server's versions now, not when the app
  // started: the partner may have rotated since (re-review N3).
  const floor = await learnFloor(state.spaceId, {
    space: spaceFrom,
    personal: personalFrom,
    rotatedRev: space?.rotated_rev ?? 0,
  });
  const held = ring
    ? activeRing(ring, state.spaceId, floor, {
        space: space?.kids ?? [],
        personal: info.user.personal_kids ?? [],
      })
    : null;
  if (!held || held.space !== 'ok' || held.personal !== 'ok' || floor.space !== spaceFrom)
    throw new Error('This device needs the current keys before it can make new ones.');
  const staged = new KeyRing(state.session.user.id);
  staged.addSpaceKey(state.spaceId, { version: spaceFrom + 1, key: generateKey() });
  staged.addPersonalKey({ version: personalFrom + 1, key: generateKey() });
  await saveRing(staged, 'staged');
  await setRotation(state.spaceId, { stage: 'staged', spaceFrom, personalFrom, backup: false });
  return generateRecoveryPhrase();
}

/**
 * Step 2 (H2): back up the old and new keys under the new phrase, and only
 * then ask the server to make the new keys current. Whatever happens after,
 * the new phrase restores everything.
 */
export function commitRotation(words: string[]): Promise<void> {
  return oneAtATime(() => commitRotationNow(words));
}

async function commitRotationNow(words: string[]): Promise<void> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) throw new Error('Not ready yet.');
  const st = rotation.value;
  const staged = await loadRing('staged');
  if (st?.stage !== 'staged' || !staged)
    throw new Error('Start again: the new keys weren’t found.');
  if (st.backup) {
    // A second press after an error: check whether the first one landed (N1).
    await retryRotationNow();
    return;
  }
  const full = copyRing(ring);
  full.mergeFrom(staged);
  // Marked first: if the answer is lost, the backup may already hold them (N4).
  await setRotation(state.spaceId, { ...st, tried: true });
  await saveBackup(words, full);
  await setRotation(state.spaceId, { ...st, tried: true, backup: true });
  await sendRotation(state.session, state.spaceId, staged, st);
}

/** After a lost answer or a network error: check whether it landed, else send it again. */
export function retryRotation(): Promise<void> {
  return oneAtATime(retryRotationNow);
}

async function retryRotationNow(): Promise<void> {
  const state = account.value;
  if (state.status !== 'ready') throw new Error('Not ready yet.');
  await refresh(state.session);
  const st = rotation.value;
  if (st?.stage !== 'staged') return; // it had landed: refresh carried on from there
  const staged = await loadRing('staged');
  if (!staged) throw new Error('Start again: the new keys weren’t found.');
  await sendRotation(state.session, state.spaceId, staged, st);
}

/** Gives up a rotation the server hasn't made current. The keys are forgotten. */
export async function abandonRotation(): Promise<void> {
  const state = account.value;
  if (state.status !== 'ready' || rotation.value?.stage !== 'staged') return;
  await dropStaged();
  await setRotation(state.spaceId, null);
}

async function sendRotation(
  session: Session,
  spaceId: string,
  staged: KeyRing,
  st: { spaceFrom: number; personalFrom: number },
): Promise<void> {
  const k = newestOf(staged, spaceId, st);
  if (!k.space || !k.personal) throw new Error('Start again: the new keys weren’t found.');
  let res: { rotated_rev: number };
  try {
    res = await api<{ rotated_rev: number }>(`/spaces/${spaceId}/rotate`, {
      body: {
        space_from: st.spaceFrom,
        personal_from: st.personalFrom,
        space_kid: keyId('space', spaceId, k.space.version, k.space.key),
        personal_kid: keyId('user', staged.userId, k.personal.version, k.personal.key),
      },
    });
  } catch (err) {
    const why =
      err instanceof ApiError && err.status >= 400 && err.status < 500 ? refusal(err.code) : null;
    if (why === 'check') {
      // Refused: maybe because an earlier try landed and its answer was lost
      // (re-review N1). Ask the server what happened; only a fresh answer
      // can drop anything (re-review 2, R1).
      await refresh(session);
      const now = rotation.value;
      if (now?.stage === 'securing') return; // it had landed
      if (!now)
        throw new Error(
          'Keys were changed on another device first. Your new recovery phrase is the one to keep.',
        );
      throw new Error('Couldn’t confirm the change. Check your connection and try again.');
    }
    // It can't go ahead (another space joined since).
    if (why === 'drop') await dropRotation(spaceId, { backup: true });
    // A passkey check needed, switched off, offline or a lost answer: the
    // keys and the new phrase stay for "Try again" (R2), which checks first.
    throw err;
  }
  await commitStaged(staged, spaceId, st, res.rotated_rev);
  await restartSync(session);
  void finishSecuring();
}

let busy: Promise<void> | null = null;
/** Presses while a call is running join it instead of sending another (N1). */
function oneAtATime(fn: () => Promise<void>): Promise<void> {
  busy ??= fn().finally(() => {
    busy = null;
  });
  return busy;
}

let securing = false;

/**
 * Step 3 (M2): re-seal everything under the new keys, then ask the server
 * how much is still under old ones, until nothing is. Resumes on every start
 * until done.
 */
async function finishSecuring(): Promise<void> {
  const state = account.value;
  if (state.status !== 'ready' || securing) return;
  securing = true;
  try {
    for (let i = 0; i < 5; i++) {
      const e = engine;
      if (!e || !(await e.settle())) return; // offline: carries on next time
      await e.reencryptAll();
      if (!(await e.settle())) return;
      const left = await api<{ space_below: number; mine_below: number }>(
        `/spaces/${state.spaceId}/rotation`,
      );
      rotationLeft.value = { space: left.space_below, mine: left.mine_below };
      if (!left.space_below && !left.mine_below) {
        rotationLeft.value = null;
        await setRotation(state.spaceId, null);
        return;
      }
    }
  } catch {
    // Carries on at the next start.
  } finally {
    securing = false;
  }
}

/** Whether the partner still needs the current space key, and this person can send it (M3). */
export function partnerNeedsKeyLink(): boolean {
  const info = me.value;
  const state = account.value;
  if (!info || state.status !== 'ready' || !state.partnerJoined) return false;
  const space = info.spaces.find((x) => x.space_id === state.spaceId);
  if (!space || space.rotated_by !== info.user.id) return false;
  if (Date.now() - (space.rotated_at ?? 0) > REKEY_WINDOW_MS) return false;
  const theirs = space.members.find((m) => m.user_id !== info.user.id);
  return (theirs?.key_version ?? 1) < (space.key_version ?? 1);
}

/** A one-time link that gives the partner the current space keys (can be made again, M3). */
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
      key_version: ring.currentSpaceKey(state.spaceId).version,
      wrapped: {
        nonce: toBase64Url(created.wrapped.nonce),
        ciphertext: toBase64Url(created.wrapped.ciphertext),
      },
    },
  });
  return `${new URL('join/', location.href.split('#')[0]).href}#${formatInviteFragment(res.id, created.secret)}`;
}

/** Tells the server this device holds the current space key, so the link stops being offered (M3). */
async function acknowledgeKeys(
  info: MeResponse,
  spaceId: string,
  floor: Floor,
  state: KeyState,
): Promise<void> {
  if (state !== 'ok' || floor.space < 2 || !ring) return;
  const mine = info.spaces
    .find((x) => x.space_id === spaceId)
    ?.members.find((m) => m.user_id === info.user.id);
  if ((mine?.key_version ?? 1) >= floor.space) return;
  const k = ring.spaceKeys(spaceId).find((x) => x.version === floor.space);
  if (!k) return;
  await api(`/spaces/${spaceId}/keys-ack`, {
    body: { key_version: k.version, kid: keyId('space', spaceId, k.version, k.key) },
  }).catch(() => {});
}

/** Both people compared the new safety code (I3). */
export async function markCompared(): Promise<void> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) return;
  const v = ring.currentSpaceKey(state.spaceId).version;
  comparedVersion.value = v;
  await kvSet(comparedKey(state.spaceId), v);
}

/** A partner invite opened by someone set up in a space of their own, with no partner yet. */
export class JoinInsteadError extends Error {
  constructor() {
    super('That’s an invite to join a space, and you have a space of your own.');
  }
}

/** Live records in this account's space, and how many are more than its settings. */
function ownSpaceCounts(): { live: number; made: number } {
  const live = store.value.entries.filter((e) => !e.rec.deleted);
  return { live: live.length, made: live.filter((e) => e.rec.kind !== 'settings').length };
}

/**
 * Set after joining with this account: the start flow asks for a new
 * recovery phrase (unless it's saved), then the safety code.
 */
export const joinedWithAccount = signal(false);

/** The joined flow is done (safety code seen). */
export async function finishJoinedFlow(): Promise<void> {
  joinedWithAccount.value = false;
  await kvSet('joined-flow', false);
}

/** A join with this account in progress, kept on the device until it's settled. */
interface Joining {
  /** The space joined. */
  space: string;
  /** The space left. */
  old: string;
  /** The name to add to the shared settings. */
  name: string;
}

/** A partner invite, opened and checked, waiting for "Join" (ADR 0016). */
export interface JoinOffer {
  fragment: string;
  /** The inviter's name, from inside the invite (not from the server). */
  inviter: string | null;
  /** Things in this account's own space that joining deletes. */
  made: number;
}
export const joinInsteadOffer = signal<JoinOffer | null>(null);

/**
 * Opens a partner invite for someone alone in a space of their own, to show
 * who it's from and what joining deletes (review 0007, L1). Syncs first so
 * the count includes what's on the server (M2).
 */
export async function openJoinOffer(fragment: string): Promise<JoinOffer> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) throw new Error('Not ready');
  await syncNow()?.catch(() => {});
  const { inviteId, secret } = parseInviteFragment(fragment);
  const inv = await api<{
    kind: string;
    space_id: string;
    wrapped: { nonce: string; ciphertext: string };
  }>(`/invites/${inviteId}`);
  if (inv.kind !== 'partner') throw new Error('That isn’t an invite to join a space.');
  const payload = openPartnerInvite(secret, inv.space_id, {
    nonce: fromBase64Url(inv.wrapped.nonce),
    ciphertext: fromBase64Url(inv.wrapped.ciphertext),
  });
  return { fragment, inviter: payload.inviter_name ?? null, made: ownSpaceCounts().made };
}

/**
 * Joins a partner's space with this account (ADR 0016). The account, its
 * devices, passkeys and personal key stay; its own space is left, and the
 * server deletes it with what's in it, in the same step as the join, only if
 * nobody else is in it and it holds no more than the person agreed to delete
 * (review 0007, H1 and M2). The new space's keys come from the invite, as for
 * any joiner. A lost answer is settled on the next start from what the server
 * says. Then: a new recovery phrase (the old backup lacks the new keys) and
 * the safety code.
 */
export async function joinWithThisAccount(offer: JoinOffer): Promise<void> {
  const state = account.value;
  if (state.status !== 'ready' || !ring || state.partnerJoined) throw new Error('Not available');
  if (rotation.value) throw new Error('Finish changing your keys first (see the banner).');
  const r = ring;
  const { inviteId, secret } = parseInviteFragment(offer.fragment);
  const inv = await api<{
    kind: string;
    space_id: string;
    wrapped: { nonce: string; ciphertext: string };
  }>(`/invites/${inviteId}`);
  if (inv.kind !== 'partner') throw new Error('That isn’t an invite to join a space.');
  const payload = openPartnerInvite(secret, inv.space_id, {
    nonce: fromBase64Url(inv.wrapped.nonce),
    ciphertext: fromBase64Url(inv.wrapped.ciphertext),
  });
  await syncNow()?.catch(() => {});
  const { live, made } = ownSpaceCounts();
  // More than the person was shown: ask again rather than delete it.
  if (made > offer.made) {
    joinInsteadOffer.value = { ...offer, made };
    throw new Error('Your space has more in it than shown. Check again before joining.');
  }
  const joining: Joining = {
    space: payload.space_id,
    old: state.spaceId,
    name: settings.value.members?.[state.slot]?.name ?? '',
  };
  for (const k of payload.keys) r.addSpaceKey(payload.space_id, k);
  await saveRing(r);
  await kvSet('joining', joining);
  try {
    await api(`/invites/${inviteId}/accept`, {
      body: { leave: { space_id: state.spaceId, records: live } },
    });
  } catch (err) {
    // A clear "no" from the server: nothing changed. No answer (offline, a
    // server error): it may have happened, so the next start asks the server.
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      r.removeSpace(payload.space_id);
      await saveRing(r);
      await kvSet('joining', null);
    } else {
      // Settle it as soon as the server can be asked (review 0007, C2).
      const retry = () => void refresh(state.session).catch(() => {});
      window.addEventListener('online', retry, { once: true });
      setTimeout(retry, 15_000);
    }
    throw err;
  }
  setPendingInvite(null);
  joinInsteadOffer.value = null;
  // Settled like any start would: this device moves to the new space.
  engine?.stop();
  engine = null;
  stopNotifications();
  stopFeeds();
  await refresh(state.session);
}

/** Drops synced and unsent records of any space but this one from this device. */
async function dropOtherSpaces(spaceId: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['envelopes', 'outbox'], 'readwrite');
  for await (const c of tx.objectStore('envelopes'))
    if (c.value.space_id !== spaceId) await c.delete();
  for await (const c of tx.objectStore('outbox'))
    if (c.value.envelope.space_id !== spaceId) await c.delete();
  await tx.done;
}

/** This device after a join with this account: the old space's keys and stale bits go. */
async function afterJoin(j: Joining): Promise<void> {
  engine?.stop();
  engine = null;
  stopNotifications();
  stopFeeds();
  if (ring) {
    ring.removeSpace(j.old);
    await saveRing(ring);
  }
  // The backup holds the old ring: a new phrase is asked for next.
  phraseStale.value = true;
  await kvSet('phrase-stale', true);
  // The server dropped the passkey unlock copies (they lack the new keys).
  await kvSet('unlocks-made', {});
  unlocksMadeHere.value = {};
  passkeyUnlocks.value = [];
}

export interface KeyLinkOffer {
  kind: 'rekey' | 'device';
  /** The safety code the new space key gives, to compare before using it (M4). */
  code: string | null;
  apply(): Promise<void>;
}

/**
 * A set-up device opens a key update link from the partner, or a device link
 * from one of my own devices. Nothing is used yet (M4, I1): the link's kind
 * is checked before it is claimed, its keys are checked against the server's
 * fingerprints and refused unless this device needs them, and the new safety
 * code is returned to compare before `apply()`.
 */
export async function openKeyLink(fragment: string): Promise<KeyLinkOffer> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) throw new Error('Not ready');
  const { inviteId, secret } = parseInviteFragment(fragment);
  const meta = await api<{ kind: 'partner' | 'device' | 'rekey'; space_id: string | null }>(
    `/invites/${inviteId}/kind`,
  );
  if (meta.kind === 'partner') {
    // Someone who made their own space by mistake (often because the invite
    // was lost on the way through email sign-in) can start over and join.
    if (!state.partnerJoined) throw new JoinInsteadError();
    throw new KeyLinkError(
      'That’s an invite for someone joining a space, and you’re already in one with your partner. Nothing was used.',
    );
  }
  if (meta.kind === 'rekey' && meta.space_id !== state.spaceId)
    throw new KeyLinkError('That link isn’t a key update for this space.');
  const info = await api<MeResponse>('/me');
  me.value = info;
  const space = info.spaces.find((x) => x.space_id === state.spaceId);
  const floor = await learnFloor(state.spaceId, {
    space: space?.key_version ?? 1,
    personal: info.user.personal_key_version ?? 1,
    rotatedRev: space?.rotated_rev ?? 0,
  });
  const kids = { space: space?.kids ?? [], personal: info.user.personal_kids ?? [] };
  const inv = await api<{
    kind: 'partner' | 'device' | 'rekey';
    space_id: string | null;
    wrapped: { nonce: string; ciphertext: string };
  }>(`/invites/${inviteId}`);
  const wrapped = {
    nonce: fromBase64Url(inv.wrapped.nonce),
    ciphertext: fromBase64Url(inv.wrapped.ciphertext),
  };
  const current = ring;
  const before = activeRing(current, state.spaceId, floor, kids).space;
  let taken: ReturnType<typeof takeKeys>;
  if (inv.kind === 'rekey' && inv.space_id === state.spaceId) {
    const payload = openRekeyInvite(secret, state.spaceId, wrapped);
    taken = takeKeys(current, state.spaceId, floor, kids, { space: payload.keys });
  } else if (inv.kind === 'device') {
    const theirs = openDeviceInvite(secret, state.session.user.id, wrapped);
    taken = takeKeys(current, state.spaceId, floor, kids, {
      space: theirs.spaceKeys(state.spaceId),
      personal: theirs.personalKeys(),
    });
  } else {
    throw new KeyLinkError('That link isn’t a key update for this space.');
  }
  const { next, setAside } = taken;
  const k = next.currentSpaceKey(state.spaceId);
  const kind = inv.kind;
  // The fingerprints come from the server, so comparing codes is the check
  // that doesn't depend on it: shown whenever the shared key changes, from
  // the partner or from one of my own devices (re-review N5).
  const changes = kind === 'rekey' || before !== 'ok';
  return {
    kind,
    code: changes ? safetyCode(state.spaceId, k.version, k.key) : null,
    apply: async () => {
      await api(`/invites/${inviteId}/accept`, { body: {} });
      if (setAside.length) await keepAside(state.session.user.id, state.spaceId, setAside);
      await saveRing(next);
      ring = next;
      setPendingInvite(null);
      if (kind === 'rekey') {
        // My backup can't hold the new key until I make a new phrase (M3).
        phraseStale.value = true;
        await kvSet('phrase-stale', true);
      }
      await restartSync(state.session);
    },
  };
}

/**
 * Keys this device held that a link replaced, because the server said they
 * weren't the real ones: kept in their own slot, never used, in case the
 * server lied (re-review N5).
 */
async function keepAside(
  userId: string,
  spaceId: string,
  keys: { scope: 'space' | 'user'; version: number; key: Uint8Array }[],
): Promise<void> {
  const aside = (await loadRing('aside')) ?? new KeyRing(userId);
  for (const k of keys) {
    try {
      if (k.scope === 'space') aside.addSpaceKey(spaceId, k);
      else aside.addPersonalKey(k);
    } catch {
      // Already set aside.
    }
  }
  await saveRing(aside, 'aside');
}

/** The pending link, waiting for the person to compare the code and confirm. */
export const keyLinkOffer = signal<KeyLinkOffer | null>(null);

/* ---------- passkey unlock (ADR 0015, review 0006) ---------- */

export interface PasskeyRow {
  id: string;
  created_at: number;
  aaguid: string | null;
  /** Added after the latest change of keys: only these can unlock (M1). */
  can_unlock: boolean;
  /**
   * Whether its app can give an unlock secret: said when it was added, or
   * found out on this device when it didn't give one. null: not known.
   */
  prf: boolean | null;
}
export interface UnlockRow {
  passkey_id: string;
  created_at: number;
  space_version: number;
  personal_version: number;
}

/** Which passkeys can unlock this account's keys, and which key versions each copy holds. */
export const passkeyUnlocks = signal<UnlockRow[] | null>(null);
/** This account's passkeys. */
export const passkeyList = signal<PasskeyRow[] | null>(null);
/** Copies this device set up (passkey id → the copy's created_at), for "Update" (M1, L4). */
export const unlocksMadeHere = signal<Record<string, number>>({});

/** The key versions in use now, to tell which copies are behind (L4). */
export function currentVersions(): { space: number; personal: number } | null {
  const state = account.value;
  if (state.status !== 'ready' || !ring) return null;
  return {
    space: ring.currentSpaceKey(state.spaceId).version,
    personal: ring.currentPersonalKey().version,
  };
}

/** The PRF request every unlock carries (the same fixed input for every passkey). */
function prfRequest(): AuthenticationExtensionsClientInputs {
  return { prf: { eval: { first: UNLOCK_SALT } } } as AuthenticationExtensionsClientInputs;
}

/**
 * The passkey's unlock secret, taken out of the extension results so it is
 * never sent anywhere (the server must never see it).
 */
function takePrf(results: object | undefined): Uint8Array | null {
  const r = results as
    | { prf?: { results?: { first?: ArrayBuffer | ArrayBufferView } } }
    | undefined;
  const first = r?.prf?.results?.first;
  if (r?.prf) delete r.prf;
  if (!first) return null;
  return first instanceof ArrayBuffer
    ? new Uint8Array(first.slice(0))
    : new Uint8Array(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength));
}

const NO_PRF =
  'That passkey can’t unlock keys: the app that keeps it doesn’t support it. Try another one, or use your recovery phrase or a device link.';
const NO_PRF_SETUP =
  'That passkey can sign you in, but the app that keeps it can’t unlock keys. Passkeys saved in iCloud Keychain (iOS 18 or later) or Google Password Manager can: add one saved there, then try again.';

/** Passkeys found on this device to give no unlock secret, so they aren't offered again. */
async function markNoUnlock(id: string): Promise<void> {
  const ids = new Set((await kvGet<string[]>('no-unlock')) ?? []);
  ids.add(id);
  await kvSet('no-unlock', [...ids]);
  passkeyList.value = (passkeyList.value ?? []).map((p) =>
    p.id === id ? { ...p, prf: false } : p,
  );
}

/**
 * Welcome back: asks a passkey for its unlock secret. A secret given without
 * face, fingerprint or passcode is refused, whatever the provider says (M2).
 */
async function unlockCeremony(): Promise<{ id: string; prf: Uint8Array }> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      timeout: 120_000,
      extensions: prfRequest(),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was chosen.');
  const prf = takePrf(cred.getClientExtensionResults());
  const data = new Uint8Array((cred.response as AuthenticatorAssertionResponse).authenticatorData);
  if (prf && !userVerified(data)) {
    prf.fill(0);
    throw new Error('Confirm with your face, fingerprint or device passcode to unlock.');
  }
  if (!prf) throw new Error(NO_PRF);
  return { id: toBase64Url(new Uint8Array(cred.rawId)), prf };
}

/** Fetches a passkey's sealed copy and opens it on this device. */
async function unlockWith(passkeyId: string, prf: Uint8Array): Promise<void> {
  const state = account.value;
  if (state.status !== 'needs-keys') return;
  const res = await api<{ wrapped: { nonce: string; ciphertext: string } }>(
    `/keys/unlock/${encodeURIComponent(passkeyId)}`,
  );
  let r: KeyRing;
  try {
    r = openUnlock(prf, state.session.user.id, passkeyId, {
      nonce: fromBase64Url(res.wrapped.nonce),
      ciphertext: fromBase64Url(res.wrapped.ciphertext),
    });
  } catch {
    throw new Error(
      'That passkey’s copy of your keys couldn’t be opened. Use a device link or your recovery phrase, then set unlocking up again.',
    );
  }
  await saveRing(r);
  ring = r;
  await refresh(state.session);
}

/** Welcome back: unlock this device's keys with a passkey instead of a link or the phrase. */
export async function unlockThisDevice(): Promise<void> {
  if (!me.value?.passkey_unlock) throw new Error('Unlocking with a passkey isn’t available.');
  const { id, prf } = await unlockCeremony();
  try {
    await unlockWith(id, prf);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404)
      throw new Error(
        'That passkey isn’t set up to unlock your keys. Use a device link or your recovery phrase.',
      );
    throw err;
  } finally {
    prf.fill(0);
  }
}

/**
 * Lets a passkey unlock this account's keys on a new device. The passkey is
 * confirmed with the server in the same touch, so only a session that just
 * used that very passkey can store a copy for it (L2). Only passkeys added
 * since the latest change of keys are offered (M1). `only` limits the choice
 * to one passkey (updating its copy).
 */
export async function enablePasskeyUnlock(only?: string): Promise<void> {
  const state = account.value;
  if (state.status !== 'ready' || !ring) throw new Error('Not ready yet.');
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const opts = await api<{
    challenge_id: string;
    options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
  }>('/auth/passkey/reauth/options', { body: {} });
  const eligible = new Set(
    (passkeyList.value ?? []).filter((p) => p.can_unlock && p.prf !== false).map((p) => p.id),
  );
  const allow = (opts.options.allowCredentials ?? []).filter(
    (c) => eligible.has(c.id) && (!only || c.id === only),
  );
  if (!allow.length)
    throw new Error(
      (passkeyList.value ?? []).some((p) => p.can_unlock)
        ? NO_PRF_SETUP
        : 'None of your passkeys can unlock: they were added before you last changed your keys. Add a new one first.',
    );
  const response = await startAuthentication({
    optionsJSON: {
      ...opts.options,
      allowCredentials: allow,
      userVerification: 'required',
      extensions: { ...opts.options.extensions, ...prfRequest() },
    },
  });
  const prf = takePrf(response.clientExtensionResults);
  try {
    if (!prf) {
      await markNoUnlock(response.id);
      throw new Error(NO_PRF_SETUP);
    }
    if (!userVerified(fromBase64Url(response.response.authenticatorData)))
      throw new Error('Confirm with your face, fingerprint or device passcode.');
    // The server checks the confirmation (with user verification), and
    // remembers this session used this passkey.
    await api('/auth/passkey/reauth/verify', {
      body: { challenge_id: opts.challenge_id, response },
    });
    const sealed = sealUnlock(prf, ring, response.id);
    const versions = currentVersions();
    await api(`/keys/unlock/${encodeURIComponent(response.id)}`, {
      method: 'PUT',
      body: {
        space_version: versions?.space ?? 1,
        personal_version: versions?.personal ?? 1,
        wrapped: { nonce: toBase64Url(sealed.nonce), ciphertext: toBase64Url(sealed.ciphertext) },
      },
    });
  } finally {
    prf?.fill(0);
  }
  if (me.value) me.value = { ...me.value, signed_in_at: Date.now() };
  await loadPasskeys();
  const made = passkeyUnlocks.value?.find((u) => u.passkey_id === response.id);
  if (made) {
    const next = { ...unlocksMadeHere.value, [response.id]: made.created_at };
    unlocksMadeHere.value = next;
    await kvSet('unlocks-made', next);
  }
}

export async function disablePasskeyUnlock(passkeyId: string): Promise<void> {
  await api(`/keys/unlock/${encodeURIComponent(passkeyId)}`, { method: 'DELETE' });
  await loadPasskeys();
}

export async function removePasskey(passkeyId: string): Promise<void> {
  await api(`/auth/passkeys/${encodeURIComponent(passkeyId)}`, { method: 'DELETE' });
  if (me.value) me.value = { ...me.value, passkeys: Math.max(0, me.value.passkeys - 1) };
  await loadPasskeys();
}

/** Passkeys, and (when unlocking is available) the copies and their key versions. */
export async function loadPasskeys(): Promise<void> {
  const list = await api<{ passkeys: PasskeyRow[] }>('/auth/passkeys');
  const noUnlock = new Set((await kvGet<string[]>('no-unlock')) ?? []);
  passkeyList.value = list.passkeys.map((p) =>
    noUnlock.has(p.id) ? { ...p, prf: false } : { ...p, prf: p.prf ?? null },
  );
  unlocksMadeHere.value = (await kvGet<Record<string, number>>('unlocks-made')) ?? {};
  passkeyUnlocks.value = me.value?.passkey_unlock
    ? (await api<{ unlocks: UnlockRow[] }>('/keys/unlocks')).unlocks
    : [];
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
