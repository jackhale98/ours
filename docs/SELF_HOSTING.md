# Self-hosting

Run your own Ours: the web app on GitHub Pages and the API on a Cloudflare Worker with a D1 database. Both free tiers are enough for a household. Check Cloudflare's current Workers and D1 free-tier limits on their pricing pages; they change. Allow about 15 minutes.

You need: a GitHub account, a Cloudflare account, and (for real sign-in emails) an account with an email API such as Resend, with a sending domain you control.

There are two ways to run it:

- **Everything on Cloudflare, set up in the browser** (recommended; ADR 0014). The app gets its own domain and real security headers, and no terminal is needed. See [All on Cloudflare](#all-on-cloudflare-no-terminal) below.
- **App on GitHub Pages, API on Cloudflare**, set up from a terminal with Node 22 (`corepack enable`). The steps follow.

The live API settings are in the `env.production` block of `apps/api/wrangler.jsonc`; the top level is for local development and tests. Every `wrangler` command for the live instance takes `--env production`.

## Steps (GitHub Pages and a terminal)

### 1. Fork and enable Pages (2 min)

1. Fork this repository.
2. In your fork: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Clone your fork and run `pnpm install`.

Your app will live at `https://<you>.github.io/<repo>/`. (A custom domain is better for a public instance; see Security notes.)

### 2. Create the database (2 min)

```sh
cd apps/api
pnpm exec wrangler login
pnpm exec wrangler d1 create ours --jurisdiction eu   # or leave out --jurisdiction; see ADR 0006
```

Copy the printed `database_id` into `env.production` in `apps/api/wrangler.jsonc`.

### 3. Configure the Worker (4 min)

In `apps/api/wrangler.jsonc`, under `env.production`, set the `routes` to your API's domain (or remove them to use `workers.dev`), and under its `vars`:

| Var | Value |
|---|---|
| `ALLOWED_ORIGINS` | `https://<you>.github.io` |
| `APP_URL` | `https://<you>.github.io/<repo>/` |
| `RP_ID` | `<you>.github.io` |
| `EMAIL_PROVIDER` / `EMAIL_FROM` | `resend` / `Ours <hello@your-domain>` |

Then the secrets (each prompts for a value):

```sh
pnpm exec wrangler secret put RATE_LIMIT_SALT --env production     # any long random string: openssl rand -base64 32
pnpm exec wrangler secret put EMAIL_API_KEY --env production       # from your email provider
pnpm exec wrangler secret put VAPID_PUBLIC_KEY --env production    # optional, for notifications ("Notifications" below)
pnpm exec wrangler secret put VAPID_PRIVATE_KEY --env production   # optional, for notifications
pnpm exec wrangler secret put TURNSTILE_SECRET --env production    # optional, bot check on sign-in
```

Never put these in `vars`: `pnpm check:worker` fails if you do.

### 4. Deploy the API (2 min)

```sh
pnpm exec wrangler d1 migrations apply ours --remote --env production
pnpm exec wrangler deploy --env production
```

Note the Worker URL it prints, e.g. `https://ours-api.<account>.workers.dev`. Check `https://…workers.dev/health` returns `{"ok":true}`.

### 5. Build the web app against it (3 min)

In your fork: **Settings → Secrets and variables → Actions → Variables**, add:

- `API_URL` = the Worker URL from step 4
- `OURS_OPERATOR` and `OURS_CONTACT` = who runs it and a contact email (shown on the privacy and terms pages; see the table below for the other legal fields)
- `TURNSTILE_SITE_KEY` = the Turnstile site key, if you set `TURNSTILE_SECRET`

Commit your `wrangler.jsonc` change and push to `main`, or run **Actions → Deploy web → Run workflow**. Open your Pages URL, choose **Get started**, and sign up.

### 6. Optional: deploy the API from GitHub too

Add repo secrets `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts: Edit, D1: Edit, and Zone → Workers Routes: Edit on your domain if the Worker has custom-domain routes) and `CLOUDFLARE_ACCOUNT_ID`, and the repo variable `CLOUDFLARE_DEPLOY=true`. Every push to `main` that touches the API then applies migrations and deploys.

### 7. Check it

- **Worker logs:** in the Cloudflare dashboard, confirm the Worker's invocation logs are off (they would store client IP addresses). `wrangler.jsonc` sets this; `pnpm check:worker` guards it.
- **Build hashes:** the Deploy web workflow prints a SHA-256 for every file it publishes. Compare them with what your browser loads if you want to be sure what you are running.
- **Bot check:** if you configured Turnstile, sign in once and confirm the check appears and passes.
- **No analytics (Cloudflare hosting):** Cloudflare may switch on Web Analytics for a new domain, which injects a tracking script into every page. The app's CSP blocks it, but turn it off: **Analytics & Logs → Web Analytics**, open your site's settings and disable it (or remove the site).
- Read the privacy policy and terms on your site and make sure they describe your instance.

## All on Cloudflare (no terminal)

Everything below happens in the Cloudflare dashboard, GitHub and your email provider's site.

1. **Domain.** Register one in Cloudflare (**Domain Registration**) or add an existing one as a zone. In the repo, set it in `apps/web/wrangler.jsonc` (`routes`) and in `env.production` of `apps/api/wrangler.jsonc` (`routes` for `api.<domain>`, `ALLOWED_ORIGINS`, `APP_URL`, `RP_ID`, `EMAIL_FROM`). Edit the files on github.com if you have no local copy.
2. **Database.** **Storage & databases → D1 → Create**, named `ours`, choosing a location or jurisdiction. Copy its **Database ID** into `env.production` → `d1_databases` → `database_id`.
3. **Deploy token.** **My Profile → API Tokens → Create Token → Custom token**: Account → **Workers Scripts: Edit**, Account → **D1: Edit**, Zone → **Workers Routes: Edit** for your domain. In GitHub, create an environment named `production` (**Settings → Environments → New environment**), limit its deployment branches to `main`, and add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (shown on the **Workers & Pages** overview) there. Every deploy job runs in that environment, so the token can't be used from any other branch. Repository secrets work too, without the branch lock. Then add the repository variables `CLOUDFLARE_DEPLOY=true` and `WEB_HOST=cloudflare` (**Settings → Secrets and variables → Actions → Variables**).
4. **Deploy the API.** **Actions → Deploy API → Run workflow.** It creates the tables, deploys the Worker and attaches its domain.
5. **Random secrets.** **Actions → Create Worker secrets → Run workflow.** It stores `RATE_LIMIT_SALT` and the notification key pair in Cloudflare without showing them.
6. **Service secrets.** In Cloudflare, **Workers & Pages → ours-api → Settings → Variables and Secrets → Add**, type **Secret**: `EMAIL_API_KEY` (your email provider's key) and, with Turnstile, `TURNSTILE_SECRET`.
7. **Build settings.** In GitHub, add the variables `API_URL` (`https://api.<domain>`), `OURS_OPERATOR`, `OURS_CONTACT` and the other legal fields (table below), and `TURNSTILE_SITE_KEY` if used.
8. **Deploy the app.** **Actions → Deploy web → Run workflow.** It builds the app with real security headers and attaches your domain.
9. **Check it.** `https://api.<domain>/health` returns `{"ok":true}`; sign up at `https://<domain>`. Keep sign-up `open` until your account exists, then switch `ALLOW_SIGNUPS` to `invite_only` if you want: invite-only refuses anyone without an invite, the first person included.

## Updating

Pull from upstream into your fork and push. Migrations run before the new Worker deploys (step 6, or run step 4 again by hand). Read `docs/adr` and the release notes for anything that needs action.

## Configuration

| Where | Name | Meaning |
|---|---|---|
| Web build env / repo variable | `OURS_BASE` | Base path. `/<repo>/` for a Pages project site, `/` for a custom domain. |
| Web build env / repo variable `API_URL` | `VITE_API_URL` | Origin of your Worker. Also added to the CSP `connect-src`. |
| Web build env / repo variables | `OURS_OPERATOR`, `OURS_CONTACT` | Who runs your instance and a contact email, shown on the privacy, terms and accessibility pages. **Set these before opening accounts**: while `OURS_OPERATOR` is empty the pages say it is a preview instance. |
| Web build env / repo variables | `OURS_GOVERNING_LAW`, `OURS_REGION`, `OURS_EMAIL_PROVIDER`, `OURS_LEGAL_DATE` | Fill the matching blanks in the legal pages (e.g. "the law of England and Wales", "data stored in the EU", "Resend"). Have the pages reviewed for your jurisdiction; they are a plain-language starting point, not legal advice. |
| `apps/api/wrangler.jsonc` vars | `ALLOWED_ORIGINS` | Comma-separated web origins allowed by CORS (e.g. `https://you.github.io`). |
| `apps/api/wrangler.jsonc` vars | `ALLOW_SIGNUPS` | `open`, `invite_only` or `closed`. Partners can always be invited. |
| `apps/api/wrangler.jsonc` | `database_id` | From `wrangler d1 create ours` (choose a jurisdiction, see ADR 0006). |
| `wrangler.jsonc` vars | `APP_URL` | Public URL of the web app, used in magic links (e.g. `https://you.github.io/ours/`). |
| `wrangler.jsonc` vars | `RP_ID`, `RP_NAME` | Passkey relying party: the web app's hostname (e.g. `you.github.io`) and a display name. |
| `wrangler.jsonc` vars | `EMAIL_PROVIDER`, `EMAIL_FROM` | `log` (sends nothing) or `resend`. |
| `wrangler secret put` | `EMAIL_API_KEY` | Provider API key. |
| `wrangler secret put` | `TURNSTILE_SECRET` | Cloudflare Turnstile secret; bot checks are skipped if unset. |
| Web build repo variable `TURNSTILE_SITE_KEY` | `VITE_TURNSTILE_SITE_KEY` | Turnstile site key for the sign-in screen. Set it together with `TURNSTILE_SECRET`: with only the secret, sign-in fails. Adds `https://challenges.cloudflare.com` to the page's CSP. |
| `wrangler secret put` | `RATE_LIMIT_SALT` | Random string used to hash rate-limit keys. |
| `wrangler.jsonc` vars | `MAX_SPACES_PER_USER`, `MAX_DEVICES_PER_USER`, `MAX_SPACE_BYTES`, `MAX_PUSHES_PER_MINUTE`, `MAX_PUSHES_PER_HOUR` | Quotas (defaults 3, 10, 20 MB, 120 sync pushes a minute, 60 notifications an hour). |
| `wrangler.jsonc` vars | `INACTIVE_WARN_DAYS`, `INACTIVE_GRACE_DAYS` | Inactive accounts get a warning email after this many days (default 365) and are deleted this many days later (default 30). Keep the privacy policy in step. |
| `wrangler.jsonc` vars | `VAPID_SUBJECT` | Web Push contact (`mailto:` or https; defaults to `APP_URL`). |
| Secrets | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push key pair. None set = notifications off. See "Notifications" below. |
| Repo variable | `WEB_HOST` | `cloudflare` deploys the web app with `apps/web/wrangler.jsonc` instead of GitHub Pages (ADR 0014). |
| Repo secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | For `deploy-api.yml`. Set repo variable `CLOUDFLARE_DEPLOY=true` to enable it. |

## Notifications

Generate a VAPID key pair once (any machine with Node 20+):

```sh
node -e '(async()=>{const k=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign"]);console.log("VAPID_PUBLIC_KEY="+Buffer.from(await crypto.subtle.exportKey("raw",k.publicKey)).toString("base64url"));console.log("VAPID_PRIVATE_KEY="+(await crypto.subtle.exportKey("jwk",k.privateKey)).d)})()'
```

Store both as secrets: `wrangler secret put VAPID_PUBLIC_KEY --env production` and `wrangler secret put VAPID_PRIVATE_KEY --env production`. The app fetches the public key from the API. Without a terminal, the **Create Worker secrets** workflow does this for you. Changing the key pair later invalidates every device's subscription; people turn notifications on again in Privacy. On iPhone and iPad, Web Push works only once Ours is added to the Home Screen (iOS 16.4+).

## Backups

D1 Time Travel provides point-in-time recovery. To restore: `wrangler d1 time-travel restore ours --timestamp=<RFC3339>` (check `wrangler d1 time-travel --help` for the current syntax). Restoring rolls back every user's data; encrypted records stay encrypted.

## Security notes

- Keep `observability.logs.invocation_logs` set to `false` in `wrangler.jsonc` (CI checks this): Cloudflare's invocation logs would otherwise store client IP addresses and invite URLs.
- Set `RATE_LIMIT_SALT` in production; with real email (`EMAIL_PROVIDER=resend`) the API refuses sign-ins without it.
- **GitHub Pages and passkeys:** on `https://<user>.github.io/<repo>/`, the passkey relying party (`RP_ID=<user>.github.io`) and the CORS origin are shared with every other project page under that GitHub account. Any of those pages could request passkeys for your RP ID or call your API from an allowed origin. Use a custom domain for a public instance.
- Never set `EMAIL_PROVIDER=dev-outbox` outside local tests: it exposes sign-in links at `/dev/outbox` and records pushes at `/dev/pushes` instead of sending them.
