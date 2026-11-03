// SPDX-License-Identifier: AGPL-3.0-or-later
// Every tracked source file must start with an SPDX license identifier.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs', '*.css', '*.sql'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => !f.endsWith('.d.ts') || f.includes('/test/'));
const missing = files.filter(
  (f) => !readFileSync(f, 'utf8').slice(0, 200).includes('SPDX-License-Identifier:'),
);
if (missing.length) {
  console.error(`Missing SPDX header:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.warn(`SPDX check passed for ${files.length} files.`);
