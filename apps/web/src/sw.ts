// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
/**
 * Service worker.
 *
 * Offline: precaches the app shell (HTML, JS, CSS, fonts, icons) so Ours
 * opens instantly and without a network. It never caches API responses or
 * anything containing user data, which lives only in the encrypted IndexedDB
 * store.
 *
 * Notifications: the push message holds a payload sealed with the space key.
 * This worker opens it with the key ring on this device, checks its
 * authenticated time window and replay id, and only then shows it.
 */
import { CryptoError, fromBase64Url, openNotification } from '@ours/core/crypto';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { kvGet, kvSet } from './account/db';
import { loadRing } from './account/keystore';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// "Add to my calendar" on iPhone and iPad: the page leaves one calendar file
// in a cache under a random name and opens it here; it is served once and
// deleted, and never touches the network (app/addtocal.tsx).
const ADD_EVENT_CACHE = 'ours-add-event';
registerRoute(
  ({ url }) => url.origin === self.location.origin && /\/add-event\/\d+\.ics$/.test(url.pathname),
  async ({ request }) => {
    const cache = await caches.open(ADD_EVENT_CACHE);
    const found = await cache.match(request.url);
    await cache.delete(request.url);
    return (
      found ?? new Response('This link has expired. Try again from the plan.', { status: 404 })
    );
  },
);
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete(ADD_EVENT_CACHE));
});

// Navigations to the app (any hash route) are served from the cached shell.
// The invite page and legal pages are their own precached HTML files.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/\/join\//, /\/legal\//, /\/add-event\//],
  }),
);

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

/* ---------- push ---------- */

interface Wrapper {
  v: 1;
  s: string; // space id
  k: number; // key version
  c: 's' | 'u'; // sealed with the space key, or this person's own key
  p: string; // nonce || ciphertext, base64url
}

const ICON = new URL('icon-192.png', self.registration.scope).href;

function parseWrapper(data: PushMessageData | null): Wrapper | null {
  try {
    const w = data?.json() as Partial<Wrapper> | undefined;
    if (
      w?.v === 1 &&
      typeof w.s === 'string' &&
      typeof w.k === 'number' &&
      (w.c === 's' || w.c === 'u') &&
      typeof w.p === 'string'
    )
      return w as Wrapper;
  } catch {
    // fall through
  }
  return null;
}

/** Ids shown recently, kept until their payload expires: drops replays. */
async function seenIds(now: number): Promise<Record<string, number>> {
  const all = (await kvGet<Record<string, number>>('seen-nids')) ?? {};
  for (const [id, expires] of Object.entries(all)) if (expires < now) delete all[id];
  return all;
}

async function tellClients(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const c of clients) c.postMessage({ type: 'ours-sync' });
}

/**
 * Why the last notification was shown in full or not, kept on this device
 * only (a reason code, never content), for Privacy → Notifications.
 */
type PushOutcome =
  | 'shown'
  | 'no-payload'
  | 'no-keys'
  | 'keys-unreadable'
  | 'key-missing'
  | 'not-authentic'
  | 'early'
  | 'expired'
  | 'duplicate';
async function note(outcome: PushOutcome): Promise<void> {
  await kvSet('push-last', { at: Date.now(), outcome }).catch(() => {});
}

/** Browsers require a visible notification for every push; say as little as possible. */
async function showGeneric(): Promise<void> {
  await self.registration.showNotification('Ours', {
    body: 'Something changed. Open Ours to see it.',
    icon: ICON,
    tag: 'ours-generic',
  });
}

/** Serialises updates to the replay list across concurrent pushes. */
async function withSeenLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (self.navigator as Navigator & { locks?: LockManager }).locks;
  return locks ? locks.request('ours-seen-nids', fn) : fn();
}

async function handlePush(data: PushMessageData | null): Promise<void> {
  const now = Date.now();
  const wrapper = parseWrapper(data);
  let unreadable = false;
  const ring = wrapper
    ? await loadRing().catch(() => {
        // Some browsers can't read the stored device key from here (WebKit).
        unreadable = true;
        return null;
      })
    : null;
  let key: Uint8Array | null = null;
  try {
    if (wrapper && ring)
      key = wrapper.c === 'u' ? ring.personalKey(wrapper.k) : ring.spaceKey(wrapper.s, wrapper.k);
  } catch {
    key = null;
  }
  if (!wrapper || !ring || !key) {
    // Signed out, keys not on this device yet, or not readable here.
    await note(
      !wrapper ? 'no-payload' : unreadable ? 'keys-unreadable' : !ring ? 'no-keys' : 'key-missing',
    );
    await showGeneric();
    return;
  }
  const bytes = fromBase64Url(wrapper.p);
  const target = {
    space_id: wrapper.s,
    scope: wrapper.c === 'u' ? ('user' as const) : ('space' as const),
    // Bound to this person: a payload meant for someone else fails to open.
    recipient: ring.userId,
  };
  const openKey = key;
  const shown = await withSeenLock(async () => {
    const seen = await seenIds(now);
    let opened: ReturnType<typeof openNotification>;
    try {
      opened = openNotification(
        openKey,
        target,
        wrapper.k,
        { nonce: bytes.subarray(0, 24), ciphertext: bytes.subarray(24) },
        now,
        (nid) => nid in seen,
      );
    } catch (err) {
      if (!(err instanceof CryptoError)) throw err;
      await note('not-authentic');
      return null; // Not authentic, or not for this person.
    }
    if (opened.status !== 'show') {
      await note(opened.status);
      return null;
    }
    seen[opened.body.nid] = opened.body.expires_at;
    await kvSet('seen-nids', seen);
    return opened.body;
  });
  await tellClients();
  if (!shown) {
    // Early, expired, replayed or not authentic: never show its claimed text,
    // but don't leave the push silent (browsers penalise that).
    await showGeneric();
    return;
  }
  await note('shown');
  await self.registration.showNotification(shown.title, {
    body: shown.body,
    icon: ICON,
    tag: shown.nid,
    data: { record_id: shown.record_id ?? null, kind: shown.kind ?? null },
    // Actions show on Chrome, Edge and Android; elsewhere a tap opens the plan.
    ...(shown.kind === 'proposal'
      ? {
          actions: [
            { action: 'yes', title: 'Yes, add it' },
            { action: 'open', title: 'Open' },
          ],
        }
      : {}),
  } as NotificationOptions);
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event.data));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { record_id?: string | null; kind?: string };
  const id = data.record_id && /^[A-Za-z0-9-]{1,64}$/.test(data.record_id) ? data.record_id : null;
  const hash = id ? `#plan&open=${id}` : '#plan';
  const url = new URL(hash, self.registration.scope).href;
  event.waitUntil(
    (async () => {
      // "Yes" is passed to the app out of band, so no link can accept a plan.
      if (event.action === 'yes' && id) await kvSet('pending-accept', { id, at: Date.now() });
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clients.find((c) => c.url.startsWith(self.registration.scope));
      if (existing) {
        await existing.focus();
        await existing.navigate(url).catch(() => existing.postMessage({ type: 'ours-open', hash }));
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The browser replaced the subscription (e.g. after expiry): the app
// re-registers it with the server the next time it opens.
self.addEventListener('pushsubscriptionchange', () => {
  void kvSet('push-resubscribe', true);
});
