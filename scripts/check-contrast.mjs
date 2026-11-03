// SPDX-License-Identifier: AGPL-3.0-or-later
// Checks WCAG 2.2 contrast of the colour pairs the UI uses, in both themes,
// reading values from apps/web/src/styles/tokens.css. Text >= 4.5:1,
// non-text UI (markers, control borders, focus ring) >= 3:1.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../apps/web/src/styles/tokens.css', import.meta.url), 'utf8');
function block(selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('Unbalanced CSS');
}
const vars = (text) =>
  Object.fromEntries(
    [...text.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]),
  );
const light = vars(block(':root {'));
const dark = { ...light, ...vars(block(':root[data-theme="dark"]')) };

const lum = (hex) => {
  const c = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const TEXT = 4.5;
const UI = 3;
const pairs = [
  ['ink', 'paper', TEXT],
  ['ink', 'surface', TEXT],
  ['ink', 'sunk', TEXT],
  ['muted', 'paper', TEXT],
  ['muted', 'surface', TEXT],
  ['muted', 'sunk', TEXT],
  ['faint', 'paper', TEXT],
  ['faint', 'surface', TEXT],
  ['faint', 'sunk', TEXT],
  ['paper', 'ink', TEXT],
  ['ours', 'paper', TEXT],
  ['ours', 'surface', TEXT],
  ['ours', 'ours-soft', TEXT],
  ['good', 'surface', TEXT],
  ['good', 'paper', TEXT],
  ['danger', 'surface', TEXT],
  ['on-accent', 'person-a', TEXT],
  ['on-accent', 'person-b', TEXT],
  ['on-accent', 'ours', TEXT],
  ['on-accent', 'good', TEXT],
  ['person-a', 'paper', UI],
  ['person-b', 'paper', UI],
  ['person-a', 'surface', UI],
  ['person-b', 'surface', UI],
  ['control', 'surface', UI],
  ['control', 'paper', UI],
  ['focus', 'paper', UI],
  ['focus', 'surface', UI],
];
let failed = 0;
for (const [name, theme] of [
  ['light', light],
  ['dark', dark],
]) {
  for (const [fg, bg, min] of pairs) {
    const r = ratio(theme[fg], theme[bg]);
    if (r < min) {
      failed++;
      console.error(`${name}: --${fg} on --${bg} = ${r.toFixed(2)} (needs ${min})`);
    }
  }
}
/*
 * Colour-vision deficiency: the two people must stay distinguishable by
 * colour as a secondary cue under protanopia, deuteranopia and tritanopia
 * (Machado et al. 2009, severity 1.0). Shape is the primary cue (circle vs
 * square markers), so this guards against regressions, not sole reliance.
 */
const CVD = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const linear = (hex) =>
  [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
const simulate = (c, m) =>
  m.map((r) => Math.min(1, Math.max(0, r[0] * c[0] + r[1] * c[1] + r[2] * c[2])));
const lab = ([r, g, b]) => {
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
const deltaE = (a, b) => {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};
const MIN_PERSON_DELTA_E = 10;
for (const [name, theme] of [
  ['light', light],
  ['dark', dark],
]) {
  for (const [kind, m] of Object.entries(CVD)) {
    const d = deltaE(
      simulate(linear(theme['person-a']), m),
      simulate(linear(theme['person-b']), m),
    );
    if (d < MIN_PERSON_DELTA_E) {
      failed++;
      console.error(
        `${name}/${kind}: --person-a vs --person-b ΔE ${d.toFixed(1)} (needs ${MIN_PERSON_DELTA_E})`,
      );
    }
  }
}

if (failed) process.exit(1);
console.warn(`Contrast check passed (${pairs.length * 2} pairs, 6 colour-blindness simulations).`);
