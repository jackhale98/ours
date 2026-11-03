// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from 'preact';
import '../styles/app.css';
import { App } from './App';
import { store } from './model';
import { seedDemo } from './seed';
import { agenda } from './select';

/** Gives the browser a chance to handle input between chunks of start-up work. */
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function mountApp(root: HTMLElement): Promise<void> {
  document.title = 'Ours · Demo';
  // Seed before the first render so the page appears once, complete, but in
  // its own task so start-up never blocks input for long.
  if (store.value.entries.length === 0) {
    await yieldToBrowser();
    seedDemo();
  }
  await yieldToBrowser();
  agenda(7); // warm the memoised agenda in its own task
  await yieldToBrowser();
  render(<App />, root);
}
