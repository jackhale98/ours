// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Try the demo" (#demo), asked for in this tab. Normally a device that's
 * signed in but not set up (no space yet, or no keys on it) shows only the
 * setup screens; asking for the demo shows it there too, with a way back.
 * The demo's sample data never reaches the account: it stays in the demo's
 * own storage, and the store is replaced by the account's records when its
 * keys arrive.
 */
import { signal } from '@preact/signals';

const KEY = 'ours.demo';

function asked(): boolean {
  if (location.hash === '#demo') return true;
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export const demoRequested = signal(asked());

export function requestDemo(on: boolean): void {
  demoRequested.value = on;
  try {
    if (on) sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the request lasts until the page is reloaded.
  }
}
