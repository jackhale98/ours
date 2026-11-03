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
if (failed) process.exit(1);
console.warn(`Contrast check passed (${pairs.length * 2} pairs).`);
