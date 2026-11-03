// SPDX-License-Identifier: AGPL-3.0-or-later
// Initial JS budget (build plan section 1): JS loaded by index.html, gzipped, ≤ 90 KB.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET = 90 * 1024;
const dist = process.argv[2] ?? 'apps/web/dist';
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const scripts = [
  ...html.matchAll(/<(?:script[^>]+src|link[^>]+rel="modulepreload"[^>]+href)="([^"]+\.js)"/g),
].map((m) => m[1]);
const base = (html.match(/src="(\/[^"]*?)assets\//) ?? [])[1] ?? '/';
let total = 0;
for (const src of new Set(scripts)) {
  const file = join(dist, src.startsWith(base) ? src.slice(base.length) : src);
  const size = gzipSync(readFileSync(file), { level: 9 }).length;
  total += size;
  console.warn(`${src}: ${(size / 1024).toFixed(1)} KB gz`);
}
console.warn(`Initial JS: ${(total / 1024).toFixed(1)} KB gz (budget ${BUDGET / 1024} KB)`);
if (scripts.length === 0 || total > BUDGET) process.exit(1);
