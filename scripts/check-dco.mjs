// SPDX-License-Identifier: AGPL-3.0-or-later
// Every commit in BASE..HEAD must carry a Signed-off-by line matching its author.
// Usage: node scripts/check-dco.mjs [base-ref]   (default: origin/main)
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? process.env.DCO_BASE ?? 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const range = `${base}..HEAD`;
const shas = git('rev-list', '--no-merges', range).split('\n').filter(Boolean);
const bad = [];
for (const sha of shas) {
  const email = git('show', '-s', '--format=%ae', sha);
  const body = git('show', '-s', '--format=%B', sha);
  const signed = [...body.matchAll(/^Signed-off-by: .+ <([^>]+)>$/gm)].map((m) => m[1]);
  if (!signed.includes(email))
    bad.push(`${sha.slice(0, 10)} ${git('show', '-s', '--format=%s', sha)}`);
}
if (bad.length) {
  console.error(
    `Commits missing a matching Signed-off-by line (see CONTRIBUTING.md):\n  ${bad.join('\n  ')}`,
  );
  process.exit(1);
}
console.warn(`DCO check passed for ${shas.length} commit(s).`);
