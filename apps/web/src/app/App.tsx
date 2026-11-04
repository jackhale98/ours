// SPDX-License-Identifier: AGPL-3.0-or-later
/** App shell: rail (desktop), tab bar + FAB (mobile), hash routing, sheets, toasts. */
import { signal } from '@preact/signals';
import { lazy, Suspense } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { kvGet, kvSet } from '../account/db';
import {
  account,
  consumeSignInLink,
  joinInsteadOffer,
  joinWithThisAccount,
  keyLinkOffer,
  newKeysFrom,
  phraseKept,
  phraseStale,
  retryRotation,
  rotation,
  rotationLeft,
  setPendingInvite,
  startOverToJoin,
  syncNow,
} from '../account/session';
import { needsNewKeys, syncStatus } from '../account/sync';
import { LogoMark } from '../Logo';
import './appearance';
import { waiting } from './inbox';
import { ItemSheetHost } from './itemsheet';
import { findEntry, mode, nameOf, names, partner, store, viewer } from './model';
import { drawerOpen, type PlanMode, planHash, setPlanMode } from './planview';
import { now } from './select';
import { accept, afterAdd, openEvent, openQuick, SheetHost, sheet } from './sheets';
import { Avatar, Icon, type IconName, ToastHost, toast } from './ui';
import { UpdateBanner } from './version';
import { PlanView } from './views/Plan';

const ListsView = lazy(() => import('./views/Lists').then((m) => ({ default: m.ListsView })));
const CheckinView = lazy(() => import('./views/Checkin').then((m) => ({ default: m.CheckinView })));
const SearchView = lazy(() => import('./views/Search').then((m) => ({ default: m.SearchView })));
const InboxView = lazy(() => import('./views/Inbox').then((m) => ({ default: m.InboxView })));
const PrivacyView = lazy(() => import('./views/Privacy').then((m) => ({ default: m.PrivacyView })));
const StartView = lazy(() => import('./views/Start').then((m) => ({ default: m.StartView })));

/** Show onboarding (sign-in, setup) instead of the tabs. */
export const startRequested = signal(location.hash === '#start');

export type Tab = 'plan' | 'lists' | 'checkin' | 'privacy' | 'inbox' | 'search';
const TABS: [Tab, string, IconName][] = [
  ['plan', 'Plan', 'cal'],
  ['lists', 'Lists', 'list'],
  ['checkin', 'Check-in', 'rings'],
  ['privacy', 'Privacy', 'shield'],
];
export const isTab = (h: string): h is Tab =>
  h === 'inbox' || h === 'search' || TABS.some(([t]) => t === h);

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
  const view = /^plan\/(week|month)$/.exec(h);
  if (view?.[1]) {
    setPlanMode(view[1] as PlanMode, false);
    tab.value = 'plan';
    startRequested.value = false;
    return;
  }
  if (h === 'plan') setPlanMode('agenda', false);
  if (isTab(h)) {
    tab.value = h;
    startRequested.value = false;
  }
}

export function go(t: Tab) {
  sheet.value = null;
  // The Plan tab reopens in the view last used on this device.
  const hash = t === 'plan' ? planHash() : t;
  if (location.hash !== `#${hash}`) location.hash = hash;
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

/** Search: a rail entry (with its shortcut) on desktop, a header button on phones. */
function SearchLink({ variant }: { variant: 'rail' | 'top' }) {
  const target: Tab = 'search';
  return (
    <a
      href={`#${target}`}
      class={variant === 'rail' ? 'navbtn' : 'iconbtn wo-top'}
      aria-current={tab.value === 'search' ? 'page' : undefined}
      aria-label={variant === 'top' ? 'Search' : undefined}
      aria-keyshortcuts="/"
      onClick={(e) => {
        e.preventDefault();
        go(target);
      }}
    >
      <Icon name="search" size={20} />
      {variant === 'rail' && (
        <>
          Search
          <kbd>/</kbd>
        </>
      )}
    </a>
  );
}

/** "Waiting on you", with how many: a rail entry on desktop, a header button on phones. */
function WaitingLink({ variant }: { variant: 'rail' | 'top' }) {
  const n = waiting.value.length;
  const label = n ? `Waiting on you: ${n}` : 'Waiting on you: nothing';
  const target: Tab = 'inbox';
  return (
    <a
      href={`#${target}`}
      class={variant === 'rail' ? 'navbtn wo-link' : 'iconbtn wo-top'}
      aria-current={tab.value === 'inbox' ? 'page' : undefined}
      aria-label={variant === 'top' ? label : undefined}
      onClick={(e) => {
        e.preventDefault();
        go(target);
      }}
    >
      <Icon name="inbox" size={20} />
      {variant === 'rail' && 'Waiting on you'}
      {n > 0 && (
        <span class="badge" aria-hidden={variant === 'top' ? 'true' : undefined}>
          {n}
        </span>
      )}
    </a>
  );
}

/** Shown while this device lacks keys that were rotated elsewhere (ADR 0013). */
function NewKeysBanner() {
  if (!needsNewKeys.value || keyLinkOffer.value) return null;
  const from = newKeysFrom();
  return (
    <div class="keybanner" role="status">
      <Icon name="lock" size={16} />
      <span>
        {from === 'my-device'
          ? 'Your keys were changed on another of your devices. On that device, go to Privacy → Link a new device, and open the link here.'
          : `${nameOf(partner.value)} changed your shared keys. Open the key update link they sent you, or a device link from your other device that already has the new keys. Until then, new plans can’t sync.`}
      </span>
    </div>
  );
}

/**
 * A key update link, opened and checked, waiting for the two of you to
 * compare the new safety code before it's used (review 0005, M4).
 */
function KeyLinkPrompt() {
  const offer = keyLinkOffer.value;
  if (!offer) return null;
  const who = nameOf(partner.value);
  const mine = offer.kind === 'device';
  return (
    <section class="keybanner keylink" aria-labelledby="kl-h">
      <Icon name="lock" size={16} />
      <div>
        <h2 class="h3" id="kl-h">
          {mine ? 'New keys from your other device' : `New keys from ${who}`}
        </h2>
        <p>
          {mine
            ? `Before using them, compare this safety code with the one in Privacy on your other device, or on ${who}’s phone:`
            : `Before using them, compare this safety code with the one on ${who}’s phone, in person or on a call:`}
        </p>
        <p class="fp">
          <span class="code">{offer.code}</span>
        </p>
        <p class="small">
          If the numbers differ, don’t use these keys: someone else made the link.
        </p>
        <div class="btnrow">
          <button
            type="button"
            class="btn sm primary"
            onClick={async () => {
              try {
                await offer.apply();
                keyLinkOffer.value = null;
                toast(
                  offer.kind === 'rekey'
                    ? 'New keys added. Make a new recovery phrase in Privacy.'
                    : 'This device has the new keys.',
                );
              } catch (err) {
                toast(err instanceof Error ? err.message : 'That link couldn’t be used.');
              }
            }}
          >
            They match, use these keys
          </button>
          <button
            type="button"
            class="btn sm ghost"
            onClick={() => {
              keyLinkOffer.value = null;
              setPendingInvite(null);
              toast('Not used. Tell them, and compare codes again once they’ve made a new link.');
            }}
          >
            They don’t match
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * A partner's invite, opened by someone who already made a space of their own
 * with nobody else in it: usually because the invite got lost on the way
 * through email sign-in. Offers to start over and join instead.
 */
function JoinInsteadPrompt() {
  const link = joinInsteadOffer.value;
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!link) return null;
  const made = store.value.entries.filter(
    (e) => !e.rec.deleted && e.rec.kind !== 'settings',
  ).length;
  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      startRequested.value = true;
      location.hash = 'start';
      toast(done);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="keybanner keylink" aria-labelledby="ji-h">
      <Icon name="lock" size={16} />
      <div>
        <h2 class="h3" id="ji-h">
          Join your partner’s space?
        </h2>
        {made === 0 ? (
          <p>
            This is an invite to your partner’s space. Your own space is empty, so you can join with
            this account: your sign-in, passkeys and devices stay, and your empty space is removed.
            Next you’ll save a new recovery phrase, and your other devices will need a device link.
          </p>
        ) : (
          <p>
            This is an invite to your partner’s space, but your own space has {made}{' '}
            {made === 1 ? 'thing' : 'things'} in it. Joining with this account needs an empty space
            for now: delete {made === 1 ? 'it' : 'them'} first, or start over (this deletes your
            account and everything in it, then you sign in again to join).
          </p>
        )}
        <div class="btnrow">
          {made === 0 ? (
            <button
              type="button"
              class="btn sm primary"
              disabled={busy}
              onClick={() =>
                void run(() => joinWithThisAccount(link), 'You’ve joined. Save your new phrase.')
              }
            >
              Join with this account
            </button>
          ) : (
            <button
              type="button"
              class="btn sm"
              disabled={busy}
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                void run(() => startOverToJoin(link), 'Done. Sign in again to join your partner.');
              }}
            >
              {armed ? 'Tap again: delete and start over' : 'Start over and join'}
            </button>
          )}
          <button
            type="button"
            class="btn sm ghost"
            onClick={() => {
              joinInsteadOffer.value = null;
              toast('Not used. Keep the link if you change your mind.');
            }}
          >
            Keep my space
          </button>
        </div>
      </div>
    </section>
  );
}

/** A rotation that's waiting on the server, or still re-encrypting (review 0005, H2 and M2). */
function RotationBanner() {
  const r = rotation.value;
  if (!r) return null;
  if (r.stage === 'staged') {
    if (!r.backup) return null;
    return (
      <div class="keybanner" role="status">
        <Icon name="lock" size={16} />
        <span>
          Your new keys aren’t in use yet: the server didn’t confirm.{' '}
          <button
            type="button"
            class="linkbtn"
            onClick={() =>
              void retryRotation().then(
                () => toast('Done. Your space has new keys.'),
                (err) =>
                  toast(err instanceof Error ? err.message : 'Still couldn’t. Try again later.'),
              )
            }
          >
            Try again
          </button>
        </span>
      </div>
    );
  }
  const left = rotationLeft.value;
  return (
    <div class="keybanner" role="status">
      <Icon name="lock" size={16} />
      <span>
        Re-encrypting under the new keys
        {left ? `: ${left.space + left.mine} left` : ''}. Keep Ours open and online for a moment.
      </span>
    </div>
  );
}

/** After taking new keys from a link, the old recovery phrase can't restore them (review 0005, M3). */
function PhraseBanner() {
  if (phraseKept.value)
    return (
      <div class="keybanner" role="status">
        <Icon name="lock" size={16} />
        <span>
          The keys didn’t change, but your new recovery phrase was saved: keep it, it’s now the one
          that restores your keys. <a href="#privacy">Details in Privacy</a>.
        </span>
      </div>
    );
  if (!phraseStale.value || needsNewKeys.value) return null;
  return (
    <div class="keybanner" role="status">
      <Icon name="lock" size={16} />
      <span>
        Your keys changed, so your recovery phrase can’t restore them.{' '}
        <a href="#privacy">Make a new phrase in Privacy</a>.
      </span>
    </div>
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
      if (e.key === '/') {
        e.preventDefault();
        go('search');
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
  const View = {
    plan: PlanView,
    lists: ListsView,
    checkin: CheckinView,
    privacy: PrivacyView,
    inbox: InboxView,
    search: SearchView,
  }[tab.value];
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
          <WaitingLink variant="rail" />
          <SearchLink variant="rail" />
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
        <main id="main" tabIndex={-1} class={`v-${onboarding ? 'start' : tab.value}`}>
          <div class="mtop">
            <a class="logo" href="./" aria-label="Ours home">
              <LogoMark size={26} />
              ours
            </a>
            <span class="demo" role={demo ? undefined : 'status'}>
              {statusText}
            </span>
            <SearchLink variant="top" />
            <WaitingLink variant="top" />
            <span class="pair">
              <Avatar slot={me} />
              <Avatar slot={p} />
            </span>
          </div>
          <UpdateBanner />
          <KeyLinkPrompt />
          <JoinInsteadPrompt />
          <NewKeysBanner />
          <RotationBanner />
          <PhraseBanner />
          <Suspense fallback={<p class="nothing">Loading…</p>}>{content}</Suspense>
        </main>
      </div>
      <nav class="tabbar" aria-label="Main">
        <Nav variant="tabbar" />
      </nav>
      {!drawerOpen.value && (
        <button type="button" class="fab" onClick={() => openQuick()} aria-label="New plan">
          <Icon name="plus" size={26} />
        </button>
      )}
      <SheetHost />
      <ItemSheetHost />
      <ToastHost />
    </>
  );
}
