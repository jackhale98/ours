// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notifications for a signed-in account (phase 5, ADR 0010).
 *
 * - This device subscribes with its browser push service; the Worker learns
 *   the push address and keys for it, nothing else.
 * - Telling the partner about a proposal or an answer: the text is sealed
 *   here with the space key for the partner's user id (core
 *   sealNotification) and sent after the record itself has synced, so a tap
 *   always finds the plan.
 * - Reminders: this device works out its upcoming reminders (8 days ahead),
 *   seals each with the person's own key (never the shared one, so a
 *   reminder about a private plan can't be read by the partner) and
 *   replaces the server's list whenever they change.
 */
import {
  type KeyRing,
  type NotificationInput,
  sealNotification,
  toBase64Url,
} from '@ours/core/crypto';
import { expand, toInstant, toWall } from '@ours/core/time';
import { effect, signal } from '@preact/signals';
import { featuresOf, type ListEntry, planOf } from '../app/lists';
import { byKind, findEntry, nameOf, type Slot, store, viewer } from '../app/model';
import { allDayParts, duration, remindersOf } from '../app/reminders';
import { fmtTime, zone } from '../app/select';
import { ApiError, api } from './api';
import { kvGet, kvSet } from './db';

export type PushState =
  | 'unsupported' // this browser has no Web Push
  | 'needs-install' // iPhone/iPad: only after adding to the Home Screen
  | 'unavailable' // this server has no push keys configured
  | 'denied' // the person blocked notifications for this site
  | 'off'
  | 'on';

export interface QuietHours {
  start: number; // minutes after midnight
  end: number;
}

export const pushState = signal<PushState>('off');
export const quietHours = signal<QuietHours | null>(null);

interface Context {
  ring: KeyRing;
  spaceId: string;
  slot: Slot;
  userId: string;
  /** The partner's user id, once they have joined. */
  partnerId: () => string | null;
  /** Resolves once local changes have reached the server. */
  synced: () => Promise<void>;
}
let ctx: Context | null = null;
let vapidKey: string | null = null;

const REMINDER_HORIZON_MS = 8 * 86_400_000;
const MAX_REMINDERS = 64;
/** All-day plans: reminders count back from 9 AM on the day. */
const ALL_DAY_TIME = '09:00';

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
function standalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Called by the session once sync is running. */
export async function startNotifications(next: Context): Promise<void> {
  ctx = next;
  await refreshPushState();
}

/** Stops this browser receiving pushes, without asking the server (e.g. after a 401). */
export async function unsubscribeLocally(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  await sub?.unsubscribe().catch(() => false);
}

export function stopNotifications(): void {
  ctx = null;
  pushState.value = 'off';
  quietHours.value = null;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function refreshPushState(): Promise<void> {
  if (!supported()) {
    pushState.value = isIos() && !standalone() ? 'needs-install' : 'unsupported';
    return;
  }
  try {
    const cfg = await api<{
      key: string | null;
      subscribed: boolean;
      quiet: { start: number; end: number; tz: string } | null;
    }>('/push/config');
    vapidKey = cfg.key;
    quietHours.value = cfg.quiet ? { start: cfg.quiet.start, end: cfg.quiet.end } : null;
    if (!cfg.key) {
      pushState.value = 'unavailable';
      return;
    }
    if (Notification.permission === 'denied') {
      pushState.value = 'denied';
      return;
    }
    const sub = await (await registration())?.pushManager.getSubscription();
    const granted = Notification.permission === 'granted';
    // The browser renewed or replaced the subscription: tell the server.
    if (sub && granted && (!cfg.subscribed || (await kvGet('push-endpoint')) !== sub.endpoint)) {
      await sendSubscription(sub);
      return;
    }
    pushState.value = cfg.subscribed && sub && granted ? 'on' : 'off';
    if (pushState.value === 'on') scheduleReminders();
  } catch {
    // Offline: keep the last state.
  }
}

async function sendSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  await api('/push/subscription', {
    method: 'PUT',
    body: { endpoint: sub.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  });
  await kvSet('push-endpoint', sub.endpoint);
  pushState.value = 'on';
  lastReminderSig = null;
  scheduleReminders();
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** Asks permission (must follow a tap) and subscribes this device. */
export async function enablePush(): Promise<void> {
  if (!vapidKey) await refreshPushState();
  if (!vapidKey) throw new Error('Notifications aren’t set up on this server.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    pushState.value = permission === 'denied' ? 'denied' : 'off';
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser settings.'
        : 'Notifications were not allowed.',
    );
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key cannot be reused.
  if (sub) {
    const key = sub.options.applicationServerKey;
    if (key && toBase64Url(new Uint8Array(key)) !== vapidKey) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(vapidKey),
  });
  await sendSubscription(sub);
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  await sub?.unsubscribe().catch(() => false);
  await api('/push/subscription', { method: 'DELETE' }).catch(() => undefined);
  // Reminders stay: this person's other devices may still want them.
  lastReminderSig = null;
  await kvSet('reminders-sig', null);
  pushState.value = 'off';
}

export async function setQuietHours(q: QuietHours | null): Promise<void> {
  await api('/push/quiet', { method: 'PUT', body: q ? { ...q, tz: zone } : null });
  quietHours.value = q;
}

/* ---------- sending ---------- */

type Recipient = 'partner' | 'me' | 'reminder';

/**
 * Seals for one recipient. Partner notifications and tests use the space
 * key; reminders use the personal key. The recipient's user id is bound in.
 */
function sealFor(input: NotificationInput, recipient: Recipient) {
  return ctx ? sealWith(ctx, input, recipient) : null;
}

/** Exported for tests: reminders must never use the shared space key (review 0003, H1). */
export function sealWith(
  c: Pick<Context, 'ring' | 'spaceId' | 'userId' | 'partnerId'>,
  input: NotificationInput,
  recipient: Recipient,
) {
  const to = recipient === 'partner' ? c.partnerId() : c.userId;
  if (!to) return null;
  const scope = recipient === 'reminder' ? 'user' : 'space';
  const key = scope === 'user' ? c.ring.currentPersonalKey() : c.ring.currentSpaceKey(c.spaceId);
  const s = sealNotification(
    key.key,
    { space_id: c.spaceId, scope, recipient: to },
    key.version,
    input,
  );
  return {
    key_version: key.version,
    payload: { nonce: toBase64Url(s.nonce), ciphertext: toBase64Url(s.ciphertext) },
  };
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Tells the partner's devices, once local changes have synced. Best effort:
 * offline, or with nobody subscribed, nothing happens and the plan still
 * arrives on their next sync.
 */
export function notifyPartner(input: NotificationInput): void {
  const c = ctx;
  if (!c) return;
  void c
    .synced()
    .then(() => {
      const sealed = sealFor(
        {
          ...input,
          title: truncate(input.title, 120),
          body: truncate(input.body, 400),
        },
        'partner',
      );
      if (!sealed) return;
      return api('/push/notify', {
        body: { space_id: c.spaceId, to: 'partner', ...sealed },
      });
    })
    .catch(() => undefined);
}

/** Sends a test notification to this person's own devices. */
export async function sendTest(): Promise<void> {
  if (!ctx) return;
  const sealed = sealFor(
    {
      title: 'Notifications are on',
      body: `This is how ${nameOf(ctx.slot === 'a' ? 'b' : 'a')}’s plans and your reminders will look.`,
      kind: 'test',
    },
    'me',
  );
  if (!sealed) return;
  try {
    await api('/push/notify', { body: { space_id: ctx.spaceId, to: 'me', ...sealed } });
  } catch (err) {
    if (err instanceof ApiError && err.status === 429)
      throw new Error('That’s a lot of tests. Try again later.');
    throw err;
  }
}

/* ---------- reminders ---------- */

interface Planned {
  fire_at: number;
  title: string;
  body: string;
  record_id: string;
  start: number;
}

/** What a reminder says, e.g. "In 15 minutes · 7 PM · Vic’s" or "Tomorrow · Saturday". */
function reminderBody(
  minutes: number,
  allDay: boolean,
  when: string,
  place: string | null,
): string {
  let lead: string;
  if (allDay) {
    const { daysBefore } = allDayParts(minutes);
    lead =
      daysBefore === 0
        ? 'Today'
        : daysBefore === 1
          ? 'Tomorrow'
          : daysBefore % 7 === 0
            ? daysBefore === 7
              ? 'In a week'
              : `In ${daysBefore / 7} weeks`
            : `In ${daysBefore} days`;
  } else {
    lead = minutes === 0 ? 'Starting now' : `In ${duration(minutes)}`;
  }
  return [lead, daysOrNull(minutes, allDay, when), place].filter(Boolean).join(' · ');
}

/** All-day reminders on the day itself don't repeat the day's name. */
const daysOrNull = (minutes: number, allDay: boolean, when: string) =>
  allDay && allDayParts(minutes).daysBefore === 0 ? null : when;

/** The reminders this person wants in the next 8 days, soonest first. */
export function plannedReminders(now = Date.now()): Planned[] {
  const me = viewer.value;
  const out: Planned[] = [];
  for (const e of byKind('event')) {
    if (e.rec.kind !== 'event') continue;
    const d = e.rec.data;
    const list = remindersOf(d, me);
    if (!list.length || d.status === 'declined') continue;
    const longest = Math.max(...list) * 60_000;
    const occurrences = expand(d, now, now + REMINDER_HORIZON_MS + longest + 86_400_000, zone);
    for (const o of occurrences) {
      const day = toWall(o.start, zone).slice(0, 10);
      const anchor = d.all_day ? toInstant(`${day}T${ALL_DAY_TIME}`, zone) : o.start;
      const when = d.all_day
        ? new Date(anchor).toLocaleDateString(undefined, { weekday: 'long', timeZone: zone })
        : fmtTime(toWall(o.start, zone).slice(11, 16));
      for (const minutes of list) {
        const fire = anchor - minutes * 60_000;
        if (fire < now || fire > now + REMINDER_HORIZON_MS) continue;
        out.push({
          fire_at: fire,
          start: o.start,
          record_id: e.id,
          title: d.title,
          body: reminderBody(minutes, d.all_day, when, d.location),
        });
      }
    }
  }
  out.push(...choreReminders(me, now));
  return out.sort((a, b) => a.fire_at - b.fire_at).slice(0, MAX_REMINDERS);
}

/** What a chore's reminder says: "Due in 15 minutes · 7 PM · Home", "Due tomorrow · Home". */
function choreBody(minutes: number, time: string | null, due: string, list: string | null) {
  let lead: string;
  let when: string | null = null;
  if (time) {
    lead = minutes <= 0 ? 'Due now' : `Due in ${duration(minutes)}`;
    when = fmtTime(time);
  } else {
    const { daysBefore } = allDayParts(minutes);
    lead =
      daysBefore === 0
        ? 'Due today'
        : daysBefore === 1
          ? 'Due tomorrow'
          : `Due in ${daysBefore} days`;
    if (daysBefore > 1)
      when = new Date(toInstant(`${due}T${ALL_DAY_TIME}`, zone)).toLocaleDateString(undefined, {
        weekday: 'long',
        timeZone: zone,
      });
  }
  return [lead, when, list].filter(Boolean).join(' · ');
}

/**
 * Chores with a due date and reminders, for whoever's on them (both of you
 * when nobody or both are). Only the next due date: ticking a repeating one
 * moves it on, and its reminders with it. Done ones, and ones on archived or
 * saved-for-later lists, don't remind.
 */
function choreReminders(me: Slot, now: number): Planned[] {
  const out: Planned[] = [];
  for (const e of byKind('item')) {
    if (e.rec.kind !== 'item') continue;
    const d = e.rec.data;
    if (d.done || !d.due || !d.reminders?.length) continue;
    if (d.before_days !== undefined && d.before_days !== null) continue;
    if (d.assignee && d.assignee !== 'both' && d.assignee !== me) continue;
    const list = findEntry(d.list_id) as ListEntry | undefined;
    if (list?.rec.kind !== 'list' || list.rec.data.archived || list.rec.data.stash) continue;
    // Only where the time and reminders can be seen and changed: a list that
    // shows due dates, not one counted from a plan.
    if (!featuresOf(list).has('due') || planOf(list)) continue;
    const anchor = toInstant(`${d.due}T${d.time ?? ALL_DAY_TIME}`, zone);
    for (const minutes of new Set(d.reminders)) {
      const fire = anchor - minutes * 60_000;
      if (fire < now || fire > now + REMINDER_HORIZON_MS) continue;
      out.push({
        fire_at: fire,
        start: anchor,
        record_id: e.id,
        title: d.text,
        body: choreBody(minutes, d.time ?? null, d.due, list.rec.data.name),
      });
    }
  }
  return out;
}

let lastReminderSig: string | null = null;
let reminderTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleReminders(): void {
  clearTimeout(reminderTimer);
  reminderTimer = setTimeout(() => void syncReminders(), 1500);
}

/** Seals planned reminders for the server: personal key, for this person only. */
export function reminderItems(
  c: Pick<Context, 'ring' | 'spaceId' | 'userId' | 'partnerId'>,
  planned: readonly Planned[],
) {
  return planned.flatMap((p) => {
    const sealed = sealWith(
      c,
      {
        title: truncate(p.title, 120),
        body: truncate(p.body, 400),
        record_id: p.record_id,
        kind: 'reminder',
        not_before: p.fire_at,
        ttl_ms: 2 * 3_600_000,
      },
      'reminder',
    );
    return sealed ? [{ fire_at: p.fire_at, ...sealed }] : [];
  });
}

/** After a key rotation the server dropped the old reminders: upload them again (review 0005, L2). */
export async function forgetReminders(): Promise<void> {
  lastReminderSig = null;
  await kvSet('reminders-sig', null);
}

/** Replaces the server's list when this device's planned reminders changed. */
export async function syncReminders(): Promise<void> {
  const c = ctx;
  if (!c || pushState.value !== 'on') return;
  const planned = plannedReminders();
  const sig = JSON.stringify(planned.map((p) => [p.fire_at, p.title, p.body, p.record_id]));
  lastReminderSig ??= (await kvGet<string | null>('reminders-sig')) ?? null;
  if (sig === lastReminderSig) return;
  const items = reminderItems(c, planned);
  try {
    await api('/push/reminders', { method: 'PUT', body: { space_id: c.spaceId, items } });
    lastReminderSig = sig;
    await kvSet('reminders-sig', sig);
  } catch {
    // Retried on the next change or app start.
  }
}

// Re-plan whenever the plans change.
effect(() => {
  void store.value;
  if (ctx && pushState.value === 'on') scheduleReminders();
});
