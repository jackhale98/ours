// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How each of you appears: a colour from a tested palette and a marker
 * shape, chosen in Settings → Appearance and shared, so you both see the same.
 *
 * The colour is applied by pointing --person-a/--person-b (and their -soft
 * tints) at a palette token, so light and dark themes follow by themselves.
 * The shape is a data attribute on <html> that the marker CSS reads.
 */
import {
  PERSON_COLORS,
  PERSON_SHAPES,
  type PersonColor,
  type PersonShape,
} from '@ours/core/schema';
import { effect } from '@preact/signals';
import { type Slot, settings, updateSettings } from './model';

export { PERSON_COLORS, PERSON_SHAPES, type PersonColor, type PersonShape };

const DEFAULT_COLOR: Record<Slot, PersonColor> = { a: 'blue', b: 'rose' };

export const COLOR_NAMES: Record<PersonColor, string> = {
  blue: 'Blue',
  rose: 'Rose',
  teal: 'Teal',
  green: 'Green',
  amber: 'Amber',
  red: 'Red',
  slate: 'Slate',
  brown: 'Brown',
};
export const SHAPE_NAMES: Record<PersonShape, string> = {
  circle: 'Circle',
  square: 'Square',
  diamond: 'Diamond',
};

export function colorOf(slot: Slot): PersonColor {
  return settings.value.members?.[slot]?.palette ?? DEFAULT_COLOR[slot];
}
export function shapeOf(slot: Slot): PersonShape {
  return settings.value.members?.[slot]?.shape ?? 'circle';
}

/** Change one person's colour or shape (only once they're in the space). */
export function setAppearance(
  slot: Slot,
  patch: { palette?: PersonColor; shape?: PersonShape },
): void {
  const members = settings.value.members ?? {};
  const m = members[slot];
  if (!m) return;
  updateSettings({ members: { ...members, [slot]: { ...m, ...patch } } });
}

// Keep the page's colours and shapes in step with the shared settings.
if (typeof document !== 'undefined') {
  effect(() => {
    const root = document.documentElement;
    for (const slot of ['a', 'b'] as const) {
      const c = colorOf(slot);
      root.style.setProperty(`--person-${slot}`, `var(--pal-${c})`);
      root.style.setProperty(`--person-${slot}-soft`, `var(--pal-${c}-soft)`);
      root.dataset[`shape${slot.toUpperCase()}`] = shapeOf(slot);
    }
  });
}

/* ---------- would the two colours look alike? ---------- */

// Colour-vision simulation (Machado et al. 2009, severity 1.0), as in
// scripts/check-contrast.mjs, which holds the default pair to the same bar.
const CVD = [
  [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
];
const linear = (hex: string) =>
  [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
const simulate = (c: number[], m: number[][]) =>
  m.map((r) =>
    Math.min(
      1,
      Math.max(
        0,
        (r[0] ?? 0) * (c[0] ?? 0) + (r[1] ?? 0) * (c[1] ?? 0) + (r[2] ?? 0) * (c[2] ?? 0),
      ),
    ),
  );
const lab = ([r = 0, g = 0, b = 0]: number[]) => {
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
const deltaE = (a: number[], b: number[]) => {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(
    (p[0] ?? 0) - (q[0] ?? 0),
    (p[1] ?? 0) - (q[1] ?? 0),
    (p[2] ?? 0) - (q[2] ?? 0),
  );
};

/** The hex a palette colour has in the theme on screen now. */
function hexOf(c: PersonColor): string | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--pal-${c}`).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

/** True when, to someone with a common kind of colour blindness, the two could be confused. */
export function looksAlike(x: PersonColor, y: PersonColor): boolean {
  const [a, b] = [hexOf(x), hexOf(y)];
  if (!a || !b) return false;
  return CVD.some((m) => deltaE(simulate(linear(a), m), simulate(linear(b), m)) < 10);
}
