// SPDX-License-Identifier: AGPL-3.0-or-later
/** Which Plan view is showing (docs/design/calendar-views.md), and the day it is looking at. */
import { signal } from '@preact/signals';

export type PlanMode = 'agenda' | 'week' | 'month';
export const PLAN_MODES: readonly PlanMode[] = ['agenda', 'week', 'month'];
const KEY = 'ours-plan-view';

function load(): PlanMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'week' || v === 'month' ? v : 'agenda';
  } catch {
    return 'agenda';
  }
}

export const planMode = signal<PlanMode>(load());
/** The chosen day in week and month views; null means today. */
export const focusDate = signal<string | null>(null);
/** The month view's day drawer is pulled up (phones): the + button steps aside. */
export const drawerOpen = signal(false);

export function setPlanMode(mode: PlanMode, updateHash = true): void {
  planMode.value = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // per-device convenience only
  }
  if (updateHash) {
    const hash = mode === 'agenda' ? '#plan' : `#plan/${mode}`;
    if (location.hash !== hash) location.hash = hash.slice(1);
  }
}

/** The hash for the Plan tab, in the view last used on this device. */
export const planHash = () => (planMode.value === 'agenda' ? 'plan' : `plan/${planMode.value}`);

/**
 * What the Plan views leave out, on this device (review 0009, P-8): one of
 * you, plans you share, imported calendars, routines.
 */
export type Hide = 'mine' | 'partner' | 'ours' | 'imported' | 'routines';
const HIDE_KEY = 'ours-plan-hide';
export const hidden = signal<ReadonlySet<Hide>>(
  (() => {
    try {
      const v = JSON.parse(localStorage.getItem(HIDE_KEY) ?? '[]');
      return new Set(Array.isArray(v) ? (v as Hide[]) : []);
    } catch {
      return new Set<Hide>();
    }
  })(),
);
export function toggleHidden(h: Hide): void {
  const next = new Set(hidden.value);
  if (next.has(h)) next.delete(h);
  else next.add(h);
  hidden.value = next;
  try {
    localStorage.setItem(HIDE_KEY, JSON.stringify([...next]));
  } catch {
    // per-device convenience only
  }
}
