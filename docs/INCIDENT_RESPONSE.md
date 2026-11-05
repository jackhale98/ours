# Incident response

A short runbook for whoever operates an Ours instance. Content is end-to-end encrypted, so a server breach does not expose plans, lists, notes or check-ins. It can expose what the server can read: email addresses, the metadata listed in [THREAT_MODEL.md](THREAT_MODEL.md), opt-in busy times for the calendar feed, quiet-hours settings, and push subscription addresses.

Keep a private log with times for every step below; you will need it for notifications.

## 1. Triage (first hour)

1. **What happened?** Leaked secret, suspicious database access, malicious deploy, compromised GitHub or Cloudflare account, vulnerability report, or abuse.
2. **Is it ongoing?** If an attacker may still have access, contain first (step 2), investigate second.
3. **Who is affected?** All users, some, or none. Note which data could have been read.

## 2. Contain

| If this leaked or was compromised | Do this |
|---|---|
| Cloudflare API token, account, or GitHub account | Revoke the token or reset the password and 2FA; review recent deploys (`wrangler deployments list`), Worker code and repo commits; redeploy from a known-good commit. |
| `EMAIL_API_KEY` | Revoke it with the email provider, `wrangler secret put EMAIL_API_KEY` with a new one. |
| `RATE_LIMIT_SALT` | `wrangler secret put RATE_LIMIT_SALT` with a new random value. Existing rate-limit windows and wrong-code counts reset, and sign-in codes already emailed stop working (links still work); nothing else is affected. |
| `TURNSTILE_SECRET` | Rotate in the Cloudflare dashboard and `wrangler secret put TURNSTILE_SECRET`. |
| `VAPID_PRIVATE_KEY` | Generate a new pair (SELF_HOSTING.md, "Notifications"), update `VAPID_PUBLIC_KEY` and the secret, and redeploy. All push subscriptions stop working: run `DELETE FROM push_subs;` and tell users to turn notifications on again. Notification text was never readable with this key. |
| The D1 database (copied or accessed) | Revoke all sessions: `DELETE FROM sessions;` (everyone signs in again; tokens are stored hashed, but revoking is cheap). Revoke calendar feed links: `UPDATE feed_tokens SET revoked_at = <now> WHERE revoked_at IS NULL;` and `DELETE FROM feed_busy;`. Pending invites: `DELETE FROM invites;`. |
| A malicious web deploy (GitHub Pages) | Roll back by redeploying a known-good commit (re-run `deploy-web.yml`). Compare the live files against the build hashes printed by the workflow. A malicious client can read data on devices that loaded it, so treat it as a content breach for users active in that window. |
| Abuse or runaway costs | Set `ALLOW_SIGNUPS` to `invite_only` or `closed` and redeploy; existing users keep working. |

Commands run with `wrangler d1 execute ours --remote --command "<SQL>"`.

## 3. Investigate

- Workers logs hold route, method, status and latency only (no IPs, bodies or tokens), and Cloudflare's invocation logs are off by design. Use them for timing and volume.
- D1 Time Travel can show the database at a point in time (`wrangler d1 time-travel info ours --timestamp=<RFC3339>`); a restore rolls back everyone's data, so use it only to undo destructive changes.
- Check GitHub audit logs, Cloudflare audit logs and the email provider's sending logs.

## 4. Notify

- **Users:** if email addresses, busy times or other metadata may have been read, email affected users promptly and plainly: what happened, what was and wasn't exposed (content stays encrypted), and what they should do (usually nothing; sign in again).
- **Regulators:** under GDPR and UK GDPR, a personal-data breach likely to risk people's rights must be reported to the supervisory authority within 72 hours of becoming aware of it. Email addresses count. Record your reasoning if you decide it isn't reportable.
- **Processors:** tell Cloudflare or the email provider if the incident involves their systems.
- **Reporter:** if someone reported a vulnerability (see SECURITY.md), keep them informed and credit them if they wish.

## 5. Recover and learn

- Confirm the fix is deployed and tests cover it.
- Write a short public post-mortem in the repository for anything users were told about.
- Add or update an ADR or a review in `docs/reviews/` if the incident changed the design.
