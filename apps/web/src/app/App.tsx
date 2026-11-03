// SPDX-License-Identifier: AGPL-3.0-or-later
/** App shell: rail (desktop), tab bar + FAB (mobile), hash routing, sheets, toasts. */
import { signal } from '@preact/signals';
import { lazy, Suspense } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { LogoMark } from '../Logo';
import { names, partner, viewer } from './model';
import { now } from './select';
import { afterAdd, openQuick, SheetHost, sheet } from './sheets';
import { Avatar, Icon, type IconName, ToastHost } from './ui';
import { PlanView } from './views/Plan';

const ListsView = lazy(() => import('./views/Lists').then((m) => ({ default: m.ListsView })));
const CheckinView = lazy(() => import('./views/Checkin').then((m) => ({ default: m.CheckinView })));
const PrivacyView = lazy(() => import('./views/Privacy').then((m) => ({ default: m.PrivacyView })));

export type Tab = 'plan' | 'lists' | 'checkin' | 'privacy';
const TABS: [Tab, string, IconName][] = [
  ['plan', 'Plan', 'cal'],
  ['lists', 'Lists', 'list'],
  ['checkin', 'Check-in', 'rings'],
  ['privacy', 'Privacy', 'shield'],
];
export const isTab = (h: string): h is Tab => TABS.some(([t]) => t === h);

export const tab = signal<Tab>('plan');
function syncFromHash() {
  const h = location.hash.slice(1);
  if (isTab(h)) tab.value = h;
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
    const onHash = () => syncFromHash();
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
    window.addEventListener('hashchange', onHash);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(tick);
    };
  }, []);

  const me = viewer.value;
  const p = partner.value;
  const n = names.value;
  const View = { plan: PlanView, lists: ListsView, checkin: CheckinView, privacy: PrivacyView }[
    tab.value
  ];

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
              Viewing as {n[me]}
            </span>
            <span class="demo">Demo · sample data</span>
          </div>
        </nav>
        <main id="main" tabIndex={-1}>
          <div class="mtop">
            <a class="logo" href="./" aria-label="Ours home">
              <LogoMark size={26} />
              ours
            </a>
            <span class="demo">Demo</span>
            <span class="pair">
              <Avatar slot={me} />
              <Avatar slot={p} />
            </span>
          </div>
          <Suspense fallback={<p class="nothing">Loading…</p>}>
            <View />
          </Suspense>
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
