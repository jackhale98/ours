// SPDX-License-Identifier: AGPL-3.0-or-later
// Guards privacy-relevant Worker settings (security review 0002, H1):
// platform invocation logs record request URLs and headers (client IPs), so
// they must stay off; the app logs route/status/latency itself.
import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const config = JSON.parse(text);
const problems = [];
const obs = config.observability;
if (obs?.enabled && obs?.logs?.invocation_logs !== false) {
  problems.push(
    'observability.logs.invocation_logs must be false (it would store client IPs and invite URLs)',
  );
}
if (obs?.traces?.enabled) problems.push('observability.traces must stay disabled');
if (config.vars?.EMAIL_PROVIDER === 'dev-outbox')
  problems.push("EMAIL_PROVIDER 'dev-outbox' is for local tests only");
if (problems.length) {
  console.error(`Worker config check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.warn('Worker config check passed.');
