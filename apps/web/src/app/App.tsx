// SPDX-License-Identifier: AGPL-3.0-or-later
/** App shell: rail (desktop), tab bar + FAB (mobile), hash routing, sheets, toasts. */
import { signal } from '@preact/signals';
import { lazy, Suspense } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { kvGet, kvSet } from '../account/db';
import { account, consumeSignInLink, syncNow } from '../account/session';
import { syncStatus } from '../account/sync';
import { LogoMark } from '../Logo';
import { findEntry, mode, names, partner, viewer } from './model';
import { now } from './select';
import { accept, afterAdd, openEvent, openQuick, SheetHost, sheet } from './sheets';
import { Avatar, Icon, type IconName, ToastHost, toast } from './ui';
import { PlanView } from './views/Plan';

const ListsView = lazy(() => import('./views/Lists').then((m) => ({ default: m.ListsView })));
const CheckinView = lazy(() => import('./views/Checkin').then((m) => ({ default: m.CheckinView })));
const PrivacyView = lazy(() => import('./views/Privacy').then((m) => ({ default: m.PrivacyView })));
const StartView = lazy(() => import('./views/Start').then((m) => ({ default: m.StartView })));

/** Show onboarding (sign-in, setup) instead of the tabs. */
export const startRequested = signal(location.hash === '#start');

export type Tab = 'plan' | 'lists' | 'checkin' | 'privacy';
const TABS: [Tab, string, IconName][] = [
  ['plan', 'Plan', 'cal'],
  ['lists', 'Lists', 'list'],
  ['checkin', 'Check-in', 'rings'],
  ['privacy', 'Privacy', 'shield'],
];
export const isTab = (h: string): h is Tab => TABS.some(([t]) => t === h);

export const tab = signal<Tab>('plan');
/**
 * Links from notifications: #plan&open=<id>. A "Yes" tapped on the
 * notification arrives separately (the service worker records it on this
 * device), so a link on its own can only open a plan, never accept it.
 */
async function deepLink(id: string): Promise<void> {
  history.replaceState(null, '', '#plan');
  tab.value = 'plan';
  startRequested.value = false;
  if (!findEntry(id)) await syncNow()?.catch(() => undefined);
  const e = findEntry(id);
  if (e?.rec.kind !== 'event') {
    toast('That plan isn’t on this device yet. It will appear once it syncs.');
    return;
  }
  const d = e.rec.data;
  const pending = await kvGet<{ id: string; at: number }>('pending-accept').catch(() => undefined);
  if (pending) await kvSet('pending-accept', null).catch(() => undefined);
  const yes = pending?.id === id && Date.now() - pending.at < 10 * 60_000;
  if (yes && d.status === 'proposed' && d.proposed_by === partner.value) accept(id);
  else openEvent(id);
}

function syncFromHash() {
  const h = location.hash.slice(1);
  const link = /^plan&open=([A-Za-z0-9-]{1,64})$/.exec(h);
  if (link?.[1]) {
    void deepLink(link[1]);
    return;
  }
  if (h === 'start') startRequested.value = true;
  if (isTab(h)) {
    tab.value = h;
    startRequested.value = false;
  }
}

export function go(t: Tab) {
  sheet.value = null;
  if (location.hash !== `#${t}`) location.hash = t;
  tab.value = t;
  window.scrollTo(0, 0);
  document.getElementById('main')?.focus({ preventScroll: true });
}

function Nav({ variant }: { variant: 'rail' | 'tabbar' }) {
  return (
    <>
      {TABS.map(([t, label, icon]) => (
        <a
          key={t}
          href={`#${t}`}
          class={variant === 'rail' ? 'navbtn' : 'tabbtn'}
          aria-current={tab.value === t ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            go(t);
          }}
        >
          <Icon name={icon} size={20} />
          {label}
        </a>
      ))}
    </>
  );
}

export function App() {
  useEffect(() => {
    syncFromHash();
    afterAdd.value = () => go('plan');
    const onHash = () => {
      if (location.hash.startsWith('#signin=')) {
        // A magic link opened in this already-running tab.
        void consumeSignInLink().then((r) => {
          if (r === 'failed') toast('That sign-in link has expired or was already used.');
          startRequested.value = true;
        });
        return;
      }
      syncFromHash();
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (sheet.value || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openQuick();
      }
    };
    // Keep "today" correct across midnight and long-lived tabs.
    const tick = setInterval(() => {
      now.value = Date.now();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') now.value = Date.now();
    };
    // The service worker says a notification arrived, or asks to open a plan.
    const onWorker = (e: MessageEvent) => {
      const data = e.data as { type?: string; hash?: string } | null;
      if (data?.type === 'ours-sync') void syncNow();
      if (data?.type === 'ours-open' && typeof data.hash === 'string') location.hash = data.hash;
    };
    navigator.serviceWorker?.addEventListener('message', onWorker);
    window.addEventListener('hashchange', onHash);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onWorker);
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(tick);
    };
  }, []);

  const me = viewer.value;
  const p = partner.value;
  const n = names.value;
  const acct = account.value.status;
  // Signed in but not set up yet (no space, or no keys on this device): onboarding only.
  const onboarding = startRequested.value || acct === 'needs-profile' || acct === 'needs-keys';
  const View = { plan: PlanView, lists: ListsView, checkin: CheckinView, privacy: PrivacyView }[
    tab.value
  ];
  // Render the element directly (not a new component each render) so the
  // onboarding state, like a generated recovery phrase, survives re-renders.
  const content = onboarding ? (
    <StartView
      onFinished={() => {
        startRequested.value = false;
        go('plan');
      }}
    />
  ) : (
    <View />
  );
  const demo = mode.value === 'demo';
  const status = syncStatus.value;
  const statusText = demo
    ? 'Demo'
    : status === 'synced'
      ? 'Synced'
      : status === 'syncing'
        ? 'Syncing'
        : status === 'offline'
          ? 'Offline'
          : 'Sync problem';

  return (
    <>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <div class="shell">
        <nav class="rail" aria-label="Main">
          <a class="logo" href="./" aria-label="Ours home">
            <LogoMark size={30} />
            ours
          </a>
          <Nav variant="rail" />
          <button type="button" class="btn primary newbtn" onClick={() => openQuick()}>
            <span class="row">
              <Icon name="plus" />
              New plan
            </span>
            <kbd>N</kbd>
          </button>
          <div class="couple">
            <span class="pair">
              <Avatar slot={me} />
              <Avatar slot={p} />
            </span>
            <span>
              <b>
                {n[me]} &amp; {n[p]}
              </b>
              <br />
              {demo ? `Viewing as ${n[me]}` : `Signed in as ${n[me]}`}
            </span>
            <span class="demo" role={demo ? undefined : 'status'}>
              {demo ? 'Demo · sample data' : statusText}
            </span>
          </div>
        </nav>
        <main id="main" tabIndex={-1}>
          <div class="mtop">
            <a class="logo" href="./" aria-label="Ours home">
              <LogoMark size={26} />
              ours
            </a>
            <span class="demo" role={demo ? undefined : 'status'}>
              {statusText}
            </span>
            <span class="pair">
              <Avatar slot={me} />
              <Avatar slot={p} />
            </span>
          </div>
          <Suspense fallback={<p class="nothing">Loading…</p>}>{content}</Suspense>
        </main>
      </div>
      <nav class="tabbar" aria-label="Main">
        <Nav variant="tabbar" />
      </nav>
      <button type="button" class="fab" onClick={() => openQuick()} aria-label="New plan">
        <Icon name="plus" size={26} />
      </button>
      <SheetHost />
      <ToastHost />
    </>
  );
}
