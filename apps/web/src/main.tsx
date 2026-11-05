// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from 'preact';
import './styles/base.css';
import './styles/landing.css';
import { Landing } from './Landing';
import { applyTheme } from './theme';

const APP_ROUTES = new Set([
  'plan',
  'lists',
  'checkin',
  'settings',
  'privacy',
  'inbox',
  'search',
  'start',
]);
const isAppRoute = () =>
  APP_ROUTES.has(location.hash.slice(1)) ||
  /^#plan[/&]/.test(location.hash) ||
  location.hash.startsWith('#signin=');

applyTheme();

// Offline support: register the service worker (production builds only).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then((reg) => import('./update').then((m) => m.watchForUpdates(reg)))
      .catch(() => {
        // Offline support is an enhancement; the app works without it.
      });
  });
}
const root = document.getElementById('app');

async function route() {
  if (!root) return;
  if (isAppRoute()) {
    // The app (and its stylesheet) loads only when someone opens it.
    const { mountApp } = await import('./app/mount');
    await mountApp(root);
  } else {
    render(<Landing />, root);
  }
}

let inApp = isAppRoute();
window.addEventListener('hashchange', () => {
  if (isAppRoute() !== inApp) {
    inApp = isAppRoute();
    render(null, root as HTMLElement);
    void route();
    window.scrollTo(0, 0);
  }
});
void route();
