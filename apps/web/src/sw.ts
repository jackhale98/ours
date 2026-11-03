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

// Navigations to the app (any hash route) are served from the cached shell.
// The invite page and legal pages are their own precached HTML files.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/\/join\//, /\/legal\//],
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
  p: string; // nonce || ciphertext, base64url
}

const ICON = new URL('icon-192.png', self.registration.scope).href;

function parseWrapper(data: PushMessageData | null): Wrapper | null {
  try {
    const w = data?.json() as Partial<Wrapper> | undefined;
    if (w?.v === 1 && typeof w.s === 'string' && typeof w.k === 'number' && typeof w.p === 'string')
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

async function handlePush(data: PushMessageData | null): Promise<void> {
  const now = Date.now();
  const wrapper = parseWrapper(data);
  const ring = wrapper ? await loadRing().catch(() => null) : null;
  let key: Uint8Array | null = null;
  try {
    if (wrapper && ring) key = ring.spaceKey(wrapper.s, wrapper.k);
  } catch {
    key = null;
  }
  if (!wrapper || !key) {
    // Signed out, or keys not on this device yet. Browsers require a visible
    // notification for each push, so say as little as possible.
    await self.registration.showNotification('Ours', {
      body: 'Something changed. Open Ours to see it.',
      icon: ICON,
      tag: 'ours-generic',
    });
    return;
  }
  const seen = await seenIds(now);
  const bytes = fromBase64Url(wrapper.p);
  let opened: ReturnType<typeof openNotification>;
  try {
    opened = openNotification(
      key,
      wrapper.s,
      wrapper.k,
      { nonce: bytes.subarray(0, 24), ciphertext: bytes.subarray(24) },
      now,
      (nid) => nid in seen,
    );
  } catch (err) {
    if (!(err instanceof CryptoError)) throw err;
    return; // Not authentic: show nothing.
  }
  await tellClients();
  if (opened.status !== 'show') return;
  const body = opened.body;
  seen[body.nid] = body.expires_at;
  await kvSet('seen-nids', seen);
  await self.registration.showNotification(body.title, {
    body: body.body,
    icon: ICON,
    tag: body.nid,
    data: { record_id: body.record_id ?? null, kind: body.kind ?? null },
    // Actions show on Chrome, Edge and Android; elsewhere a tap opens the plan.
    ...(body.kind === 'proposal'
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
  const hash = event.action === 'yes' && id ? `#accept=${id}` : id ? `#plan&open=${id}` : '#plan';
  const url = new URL(hash, self.registration.scope).href;
  event.waitUntil(
    (async () => {
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
