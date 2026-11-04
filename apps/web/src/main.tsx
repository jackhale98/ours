// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from 'preact';
import './styles/base.css';
import './styles/landing.css';
import { APP_NAME, HAS_API } from './config';
import { LogoMark } from './Logo';
import { applyShapes, applyTheme } from './theme';

const APP_ROUTES = new Set(['plan', 'lists', 'checkin', 'privacy', 'inbox', 'start']);
const isAppRoute = () =>
  APP_ROUTES.has(location.hash.slice(1)) ||
  /^#plan[/&]/.test(location.hash) ||
  location.hash.startsWith('#signin=');

function Landing() {
  return (
    <>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <header class="page top">
        <span class="logo">
          <LogoMark />
          {APP_NAME.toLowerCase()}
        </span>
      </header>
      <main id="main" class="page">
        <section class="hero">
          <p class="eyebrow">Free · open source · end-to-end encrypted</p>
          <h1>One calendar for the two of you.</h1>
          <p class="lede">
            A shared week, plans you can propose and accept, lists with owners, and a ten-minute
            weekly check-in. Everything is encrypted on your devices before it syncs.
          </p>
          <div class="cta">
            {HAS_API && (
              <a class="btn primary" href="#start">
                Get started
              </a>
            )}
            <a class={HAS_API ? 'btn' : 'btn primary'} href="#plan">
              Try the demo
            </a>
            <span class="lede small">No account. Sample data stays in this browser.</span>
          </div>
        </section>
        <div class="cards">
          <section class="card">
            <h2>What the server can’t read</h2>
            <p>
              Plan titles, times, places, notes, lists, check-ins and your names. They are encrypted
              with keys that never leave your devices.
            </p>
          </section>
          <section class="card">
            <h2>What it can see</h2>
            <ul>
              <li>Your email address</li>
              <li>How many records you have, roughly how large, and when they change</li>
              <li>When reminders fire and when notifications are sent</li>
              <li>Busy times, only if you turn on the calendar feed</li>
            </ul>
          </section>
          <section class="card">
            <h2>If you lose everything</h2>
            <p>
              Lose every device and your 12-word recovery phrase, and your data is gone for good.
              Not even we can get it back. That is the price of real privacy, and we say it up
              front.
            </p>
          </section>
        </div>
        <p class="foot">
          {HAS_API ? 'Early build.' : 'Early build: accounts and sync are not live here yet.'}{' '}
          <a href="legal/privacy/">Privacy</a> · <a href="legal/terms/">Terms</a> ·{' '}
          <a href="legal/accessibility/">Accessibility</a> ·{' '}
          <a href="https://github.com/jackhale98/ours">Source code</a>
        </p>
      </main>
    </>
  );
}

applyTheme();
applyShapes();

// Offline support: register the service worker (production builds only).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
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
