# Self-hosting

> Draft. A complete "deploy in under 15 minutes" guide is a phase 7 deliverable; this page records what is already configurable.

You need a GitHub account (for Pages) and a Cloudflare account (Workers + D1). Both free tiers are enough for a household. Check current free-tier limits at build time on Cloudflare's pricing pages for Workers and D1; they change.

## Configuration

| Where | Name | Meaning |
|---|---|---|
| Web build env / repo variable | `OURS_BASE` | Base path. `/<repo>/` for a Pages project site, `/` for a custom domain. |
| Web build env / repo variable `API_URL` | `VITE_API_URL` | Origin of your Worker. Also added to the CSP `connect-src`. |
| `apps/api/wrangler.jsonc` vars | `ALLOWED_ORIGINS` | Comma-separated web origins allowed by CORS (e.g. `https://you.github.io`). |
| `apps/api/wrangler.jsonc` vars | `ALLOW_SIGNUPS` | `open`, `invite_only` or `closed`. Partners can always be invited. |
| `apps/api/wrangler.jsonc` | `database_id` | From `wrangler d1 create ours` (choose a jurisdiction, see ADR 0006). |
| `wrangler.jsonc` vars | `APP_URL` | Public URL of the web app, used in magic links (e.g. `https://you.github.io/ours/`). |
| `wrangler.jsonc` vars | `RP_ID`, `RP_NAME` | Passkey relying party: the web app's hostname (e.g. `you.github.io`) and a display name. |
| `wrangler.jsonc` vars | `EMAIL_PROVIDER`, `EMAIL_FROM` | `log` (sends nothing) or `resend`. |
| `wrangler secret put` | `EMAIL_API_KEY` | Provider API key. |
| `wrangler secret put` | `TURNSTILE_SECRET` | Cloudflare Turnstile secret; bot checks are skipped if unset. |
| `wrangler secret put` | `RATE_LIMIT_SALT` | Random string used to hash rate-limit keys. |
| `wrangler.jsonc` vars | `MAX_SPACES_PER_USER`, `MAX_DEVICES_PER_USER`, `MAX_SPACE_BYTES`, `MAX_PUSHES_PER_MINUTE` | Quotas (defaults 3, 10, 20 MB, 120). |
| Repo secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | For `deploy-api.yml`. Set repo variable `CLOUDFLARE_DEPLOY=true` to enable it. |

## Backups

D1 Time Travel provides point-in-time recovery. To restore: `wrangler d1 time-travel restore ours --timestamp=<RFC3339>` (check `wrangler d1 time-travel --help` for the current syntax). Restoring rolls back every user's data; encrypted records stay encrypted.

## Security notes

- Keep `observability.logs.invocation_logs` set to `false` in `wrangler.jsonc` (CI checks this): Cloudflare's invocation logs would otherwise store client IP addresses and invite URLs.
- Set `RATE_LIMIT_SALT` in production; with real email (`EMAIL_PROVIDER=resend`) the API refuses sign-ins without it.
- **GitHub Pages and passkeys:** on `https://<user>.github.io/<repo>/`, the passkey relying party (`RP_ID=<user>.github.io`) and the CORS origin are shared with every other project page under that GitHub account. Any of those pages could request passkeys for your RP ID or call your API from an allowed origin. Use a custom domain for a public instance.
- Never set `EMAIL_PROVIDER=dev-outbox` outside local tests: it exposes sign-in links at `/dev/outbox`.
