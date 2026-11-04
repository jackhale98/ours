// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from 'preact';
import '../styles/app.css';
import {
  account,
  consumeSignInLink,
  JoinInsteadError,
  joinInsteadOffer,
  keyLinkOffer,
  openJoinOffer,
  openKeyLink,
  pendingInvite,
  restore,
  setPendingInvite,
} from '../account/session';
import { App, startRequested } from './App';
import { store } from './model';
import { seedDemo } from './seed';
import { agenda } from './select';
import { toast } from './ui';

/** Gives the browser a chance to handle input between chunks of start-up work. */
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function mountApp(root: HTMLElement): Promise<void> {
  // Restore a signed-in account first, so demo data can never be written into it.
  await restore().catch(() => {
    account.value = { status: 'none' };
  });
  // A magic link lands here as #signin=<token>.
  const signin = await consumeSignInLink();
  if (signin !== 'none') {
    if (signin === 'failed') toast('That sign-in link has expired or was already used.');
    startRequested.value = true;
  }

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
  if (state.status === 'none' && store.value.entries.length === 0 && !startRequested.value) {
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
