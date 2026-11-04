// SPDX-License-Identifier: AGPL-3.0-or-later
/** Manual light/dark override (a per-browser convenience, kept in localStorage). */
import { signal } from '@preact/signals';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'ours-theme';

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const theme = signal<ThemePref>(read());

export function applyTheme(pref: ThemePref = theme.value): void {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export function setTheme(pref: ThemePref): void {
  theme.value = pref;
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
  applyTheme(pref);
}
