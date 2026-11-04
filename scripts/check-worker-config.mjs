// SPDX-License-Identifier: AGPL-3.0-or-later
// Guards privacy-relevant Worker settings (security review 0002, H1):
// platform invocation logs record request URLs and headers (client IPs), so
// they must stay off; the app logs route/status/latency itself.
import { readFileSync } from 'node:fs';

const read = (path) =>
  JSON.parse(
    readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1'),
  );
const config = read('../apps/api/wrangler.jsonc');
const problems = [];
// The API at the top level and in each environment, and the web app's Worker
// (ADR 0014): none may keep request logs.
const observed = [
  ['api', config.observability],
  ...Object.entries(config.env ?? {}).map(([name, e]) => [`api env.${name}`, e?.observability]),
  ['web', read('../apps/web/wrangler.jsonc').observability],
];
for (const [where, obs] of observed) {
  if (obs?.enabled && obs?.logs?.invocation_logs !== false) {
    problems.push(
      `${where}: observability.logs.invocation_logs must be false (it would store client IPs and invite URLs)`,
    );
  }
  if (obs?.traces?.enabled) problems.push(`${where}: observability.traces must stay disabled`);
}
// Every vars block: top level and each environment (security review 0003, I5).
const varBlocks = [
  ['vars', config.vars],
  ...Object.entries(config.env ?? {}).map(([name, e]) => [`env.${name}.vars`, e?.vars]),
];
for (const [where, vars] of varBlocks) {
  if (!vars) continue;
  for (const secret of [
    'VAPID_PRIVATE_KEY',
    'EMAIL_API_KEY',
    'TURNSTILE_SECRET',
    'RATE_LIMIT_SALT',
  ]) {
    if (secret in vars)
      problems.push(`${where}.${secret} must be a secret (wrangler secret put), not a var`);
  }
  if (vars.EMAIL_PROVIDER === 'dev-outbox')
    problems.push(`${where}.EMAIL_PROVIDER 'dev-outbox' is for local tests only`);
  if (vars.VAPID_SUBJECT && !/^(mailto:|https:\/\/)/.test(vars.VAPID_SUBJECT))
    problems.push(`${where}.VAPID_SUBJECT must start with mailto: or https://`);
}
if (problems.length) {
  console.error(`Worker config check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.warn('Worker config check passed.');
