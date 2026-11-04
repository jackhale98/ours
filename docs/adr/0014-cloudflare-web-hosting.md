# 0014. Serve the web app from Cloudflare, on its own domain

- Status: Accepted
- Date: 2026-11-04

## Context
The web app was published to GitHub Pages at `<user>.github.io/<repo>/`. That has two weaknesses for a public instance:

- **A shared origin.** Every Pages project under the account shares `<user>.github.io`, so any of them is an allowed CORS origin for the API and can ask for passkeys for the same relying party (SELF_HOSTING.md, Security notes).
- **No response headers.** Pages can't send custom headers, so the content security policy is a `<meta>` tag. Browsers ignore `frame-ancestors` there, so another site can frame the app to trick clicks. There is also no HSTS, `X-Content-Type-Options` or `Referrer-Policy` beyond the meta equivalent.

The API already runs on Cloudflare, and the owner registered `ourplanner.app` there.

## Options
1. **Stay on Pages with a custom domain.** Fixes the shared origin, not the headers.
2. **One Worker for app and API on one origin.** Simplest CORS, but couples app and API deploys and mixes API routes with static paths.
3. **Two Workers: an assets-only Worker for the app (`ourplanner.app`) and the API Worker (`api.ourplanner.app`).** Real headers from a `_headers` file, Cloudflare-managed certificates and DNS, independent deploys.

## Decision
Option 3.

- `apps/web/wrangler.jsonc` is an assets-only Worker on its custom domain, with `workers.dev` and preview URLs off (a second origin the API would refuse anyway) and no request logs.
- The build writes `dist/_headers`: the same CSP as the meta tag plus `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS, `nosniff`, `no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, a restrictive `Permissions-Policy`, and a year's caching for hashed assets. The meta tag stays for hosts without headers.
- `deploy-web.yml` deploys there when the repository variable `WEB_HOST` is `cloudflare`, and to GitHub Pages otherwise, so forks keep working unchanged. Build hashes are still published either way.
- The API's live settings move to `env.production` in `apps/api/wrangler.jsonc` (deployed with `--env production`), leaving the top level for local development and tests. The deploy refuses to run while its database id is a placeholder.
- Random secrets (`RATE_LIMIT_SALT`, the notification key pair) are made and stored by a manual workflow, `worker-secrets.yml`, so no one needs a terminal or ever sees them. Secrets from other services are pasted into the Cloudflare dashboard.

## Consequences
- One company now serves both the code and the API. The published build hashes, the open source code and the end-to-end encryption are unchanged; the trust in the operator is the same as before, since the owner controls both accounts.
- The deploy token needs **Zone → Workers Routes → Edit** on the domain, as well as Workers and D1 permissions.
- Sign-up must be `open` until the first account exists: `invite_only` refuses anyone without an invite.
