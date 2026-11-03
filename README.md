# Ours

A free, open-source, end-to-end encrypted planner for couples: a shared calendar, proposals, lists, and a weekly check-in.

> **Status: early development (phase 0–1 of 7).** The core encryption, data and parsing library exists and is tested. There is no usable app or public instance yet. See [the build plan phases](docs/ARCHITECTURE.md#delivery-phases).

## What is protected, and what is not

Everything you write (event titles, times, notes, lists, check-ins, names) is encrypted on your device with keys the server never sees. The server stores ciphertext and relays it between your devices and your partner's.

The server **can** see, and this design does not hide:

- your account email address;
- how many records you have, roughly how large they are, and when they change;
- when your devices sync, and their IP addresses (in transit; never stored in the database);
- when reminders are scheduled to fire and when push notifications are sent;
- busy blocks you choose to publish to the optional calendar feed.

It also does **not** protect you against:

- **a compromised device or browser**: anyone who can use your unlocked device can read your plans;
- **malicious app code.** The web app is served from GitHub Pages. Whoever controls this repository or its Pages deployment could ship code that steals keys. Mitigations: the code is open source, `main` is protected with required reviews, CI actions are pinned by commit, and each release publishes build hashes so you can check what you are running.

If you lose all your devices **and** your 12-word recovery phrase, your data cannot be recovered by anyone, including the people running the server.

Full details: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Repository layout

```
apps/web        Preact PWA (GitHub Pages)
apps/api        Cloudflare Worker (Hono, D1)
packages/core   crypto, schema, sync, time, parse — shared, framework-free TypeScript
docs/           architecture, threat model, ADRs, self-hosting
```

## Development

Requires Node 22 and pnpm (via `corepack enable`).

```sh
pnpm install
pnpm test            # core + web unit tests
pnpm test:api        # Worker tests (Miniflare)
pnpm lint && pnpm typecheck
pnpm --filter @ours/web dev
pnpm e2e             # Playwright
```

## Running your own

Anyone can self-host on free tiers: see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

The official instance, once launched, is a free personal project run on a best-effort basis, with no uptime or support guarantees.

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md) — every commit needs a DCO `Signed-off-by` line.
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities.

## License

[AGPL-3.0-or-later](LICENSE). If you run a modified version as a service, you must offer its source to your users. See [ADR 0001](docs/adr/0001-license.md).
