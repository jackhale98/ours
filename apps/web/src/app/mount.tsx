// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from 'preact';
import '../styles/app.css';
import {
  ALREADY_SIGNED_IN,
  account,
  JoinInsteadError,
  joinInsteadOffer,
  keyLinkOffer,
  openJoinOffer,
  openKeyLink,
  pendingInvite,
  restore,
  setPendingInvite,
  takeSignInLink,
} from '../account/session';
import { App, startRequested } from './App';
import { demoRequested } from './demo';
import { store } from './model';
import { seedDemo } from './seed';
import { agenda } from './select';
import { toast } from './ui';

/** Gives the browser a chance to handle input between chunks of start-up work. */
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Whether the last input was a touch or click, or keys: the milestone strip
 * is focusable so keys can scroll it, and a tap (or closing a plan opened
 * from it) gives it focus too, which shouldn't draw the keyboard outline.
 */
function trackInput(): void {
  const html = document.documentElement;
  const set = (v: string) => () => {
    if (html.dataset.input !== v) html.dataset.input = v;
  };
  addEventListener('pointerdown', set('pointer'), { capture: true, passive: true });
  addEventListener('keydown', set('keys'), { capture: true });
}

export async function mountApp(root: HTMLElement): Promise<void> {
  trackInput();
  // Restore a signed-in account first, so demo data can never be written into it.
  await restore().catch(() => {
    account.value = { status: 'none' };
  });
  // A magic link lands here as #signin=<token>: kept until a tap signs in.
  const signin = takeSignInLink();
  if (signin === 'kept') startRequested.value = true;
  else if (signin === 'signed-in') toast(ALREADY_SIGNED_IN);

  // A key update or device link opened on a device that is already set up.
  // Its keys are checked first; a link that changes the shared key then
  // waits for the new safety code to be compared (review 0005, M4 and N5).
  const link = pendingInvite();
  if (link && account.value.status === 'ready') {
    startRequested.value = false;
    try {
      const offer = await openKeyLink(link);
      if (offer.code) keyLinkOffer.value = offer;
      else {
        await offer.apply();
        toast('This device has the new keys.');
      }
    } catch (err) {
      setPendingInvite(null);
      if (err instanceof JoinInsteadError) {
        try {
          joinInsteadOffer.value = await openJoinOffer(link);
        } catch (e) {
          toast(e instanceof Error ? e.message : 'That invite couldn’t be opened.');
        }
      } else toast(err instanceof Error ? err.message : 'That link couldn’t be used.');
    }
  }

  const state = account.value;
  document.title = state.status === 'none' ? 'Ours · Demo' : 'Ours';
  // The demo: for anyone not signed in, and for a device signed in but not set
  // up that asked for it ("Try the demo").
  const demo =
    state.status === 'none' ||
    (demoRequested.value && (state.status === 'needs-keys' || state.status === 'needs-profile'));
  if (demo && store.value.entries.length === 0 && !startRequested.value) {
    // Seed before the first render so the page appears once, complete, but in
    // its own task so start-up never blocks input for long.
    await yieldToBrowser();
    seedDemo();
  }
  await yieldToBrowser();
  agenda(7); // warm the memoised agenda in its own task
  await yieldToBrowser();
  render(<App />, root);
}
