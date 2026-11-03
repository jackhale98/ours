// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
/**
 * Service worker: precaches the app shell so Ours opens instantly and works
 * offline. It caches only the static build (HTML, JS, CSS, fonts, icons):
 * never API responses or anything containing user data, which lives only in
 * the encrypted IndexedDB store. Push handling arrives in phase 5.
 */
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

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
