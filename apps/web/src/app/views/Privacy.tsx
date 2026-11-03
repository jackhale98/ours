// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateRecoveryPhrase, safetyCode } from '@ours/core/crypto';
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { setTheme, type ThemePref, theme } from '../../theme';
import { names, SPACE_ID, setViewer, spaceKey, store, viewer } from '../model';
import { seedDemo } from '../seed';
import { Avatar, Icon, toast } from '../ui';
import { CalendarsCard } from './Calendars';

const REPO = 'https://github.com/jackhale98/ours';
const example = signal<string[] | null>(null);

function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PrivacyView() {
  const me = viewer.value;
  const n = names.value;
  const [resetArmed, setResetArmed] = useState(false);
  const code = safetyCode(SPACE_ID, 1, spaceKey());
  const themes: [ThemePref, string][] = [
    ['system', 'System'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ];

  return (
    <>
      <header class="vhead">
        <div>
          <p class="eyebrow">
            {n.a} &amp; {n.b}
          </p>
          <h1>Privacy</h1>
        </div>
      </header>
      <div class="cards">
        <section class="card">
          <div class="status">
            <span class="shield" aria-hidden="true">
              <Icon name="shield" size={22} />
            </span>
            <div class="stack">
              <h2 class="h3">End-to-end encrypted</h2>
              <p class="d">
                Plans, lists and notes are encrypted on your devices before they sync. The server
                stores scrambled data it can’t read. It does see your email address, when things
                change, and when a reminder should fire, but not what it says.
              </p>
              <p class="fp">
                Safety code <span class="code">{code}</span>
              </p>
              <p class="d small">
                Compare this with {n[me === 'a' ? 'b' : 'a']}’s phone in person. If the numbers
                match, nobody swapped your invite link.
              </p>
              <p class="d small">
                <a href={`${REPO}/blob/main/docs/THREAT_MODEL.md`}>What is and isn’t protected</a>
              </p>
            </div>
          </div>
        </section>

        <section class="card" aria-labelledby="dev-h">
          <h2 class="h3" id="dev-h">
            Devices with the key
          </h2>
          <ul class="devs">
            <li>
              <Icon name="phone" />
              <span>{n[me]}’s phone</span>
              <span class="when">This device</span>
            </li>
            <li>
              <Icon name="laptop" />
              <span>{n[me]}’s laptop</span>
              <span class="when">2 hours ago</span>
            </li>
            <li>
              <Icon name="phone" />
              <span>{n[me === 'a' ? 'b' : 'a']}’s phone</span>
              <span class="when">Active now</span>
            </li>
          </ul>
          <p class="d small">
            Sample devices. With an account you can see and remove your real ones here.
          </p>
        </section>

        <CalendarsCard />

        <section class="card" aria-labelledby="rec-h">
          <h2 class="h3" id="rec-h">
            Recovery phrase
          </h2>
          <p class="d">
            When you set up, you write down 12 words. If you lose all your devices, they’re the only
            way back to your private plans and lists. {n[me === 'a' ? 'b' : 'a']} can always
            re-invite you to shared plans. We never store the words, so we can’t show them again,
            but you can make a new phrase from any of your devices.
          </p>
          {example.value && (
            <ol class="words" aria-label="Example recovery phrase">
              {example.value.map((w, i) => (
                <li key={`${i}-${w}`}>{w}</li>
              ))}
            </ol>
          )}
          <div class="btnrow">
            <button
              type="button"
              class="btn sm"
              onClick={() => {
                example.value = example.value ? null : generateRecoveryPhrase();
              }}
            >
              <Icon name="eye" size={15} />
              {example.value ? 'Hide example' : 'Show an example phrase'}
            </button>
          </div>
        </section>

        <section class="card" aria-labelledby="as-h">
          <h2 class="h3" id="as-h">
            See it as {n[me === 'a' ? 'b' : 'a']}
          </h2>
          <p class="d">
            Switch sides to check what your partner sees. Private plans turn into “Busy” and
            personal lists disappear. (In the demo you can switch fully; on a real device this is a
            preview of your own data.)
          </p>
          {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
          <div class="seg two" role="group" aria-label="View as">
            {(['a', 'b'] as const).map((slot) => (
              <button
                type="button"
                key={slot}
                aria-pressed={slot === me}
                onClick={() => {
                  setViewer(slot);
                  toast(`Now viewing as ${n[slot]}.`);
                }}
              >
                <Avatar slot={slot} small />
                {n[slot]}
              </button>
            ))}
          </div>
        </section>

        <section class="card" aria-labelledby="theme-h">
          <h2 class="h3" id="theme-h">
            Appearance
          </h2>
          {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
          <div class="seg" role="group" aria-labelledby="theme-h">
            {themes.map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={theme.value === value}
                onClick={() => setTheme(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section class="card" aria-labelledby="data-h">
          <h2 class="h3" id="data-h">
            Your data
          </h2>
          <p class="d">
            Export everything as a JSON backup, decrypted on this device. Demo data lives only in
            this browser and never leaves it.
          </p>
          <div class="btnrow">
            <button
              type="button"
              class="btn sm"
              onClick={() => {
                download(
                  'ours-demo-export.json',
                  'application/json',
                  JSON.stringify(store.value.entries, null, 2),
                );
                toast('Export downloaded.');
              }}
            >
              <Icon name="download" size={15} />
              Export
            </button>
            <button
              type="button"
              class="btn sm ghost"
              onClick={() => {
                if (!resetArmed) {
                  setResetArmed(true);
                  return;
                }
                setResetArmed(false);
                seedDemo();
                toast('Demo data reset.');
              }}
            >
              {resetArmed ? 'Tap again to reset' : 'Reset demo data'}
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
