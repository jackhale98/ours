// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * New versions of the site, for an app that's always open. The service
 * worker downloads a new build in the background, then waits: switching
 * under a running page could mix old and new code. It only takes over once
 * every window of the app is closed, and an app on a phone's Home Screen is
 * rarely closed. So the app looks for new builds when it comes back to the
 * front (and every 30 minutes), says when one is ready, and switches when the
 * person taps Update (the worker's "skip-waiting" message), then reloads.
 */
import { signal } from '@preact/signals';

/** A new build is downloaded and waiting for the go-ahead. */
export const updateReady = signal(false);

let registration: ServiceWorkerRegistration | null = null;
let waiting: ServiceWorker | null = null;

const found = (w: ServiceWorker | null) => {
  // No controller = the very first install: nothing older to replace.
  if (!w || !navigator.serviceWorker.controller) return;
  waiting = w;
  updateReady.value = true;
};

/** Called once the service worker is registered. */
export function watchForUpdates(reg: ServiceWorkerRegistration): void {
  registration = reg;
  found(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed') found(w);
    });
  });
  const check = () => {
    void reg.update().catch(() => {
      // Offline: try again next time.
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  setInterval(check, 30 * 60_000);
}

/** Look now; resolves once the check (and any download) is done. */
export async function checkForUpdate(): Promise<'ready' | 'latest' | 'offline'> {
  if (updateReady.value) return 'ready';
  if (!registration) return 'latest';
  try {
    await registration.update();
  } catch {
    return 'offline';
  }
  // A new build downloads after the check: wait for it, up to 15 seconds.
  const installing = registration.installing;
  if (installing) {
    await new Promise<void>((done) => {
      const t = setTimeout(done, 15_000);
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' || installing.state === 'redundant') {
          clearTimeout(t);
          done();
        }
      });
    });
    found(registration.waiting);
  }
  return updateReady.value ? 'ready' : 'latest';
}

/** Switch to the new build and reload into it. */
export function applyUpdate(): void {
  if (!waiting) {
    location.reload();
    return;
  }
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  waiting.postMessage('skip-waiting');
}
