# Ours

A free, open-source, end-to-end encrypted planner for couples: a shared calendar, proposals, lists, and a weekly check-in.

> **Status: release candidate.** Everything in the build plan is built and has been through independent security reviews ([docs/reviews](docs/reviews)): end-to-end encrypted accounts and sync, pairing with safety codes, recovery phrases, plans, proposals, lists, the weekly check-in, calendar import and an opt-in busy feed, encrypted notifications and reminders, and export and import. Key rotation is built and under review. The public site currently runs as a **local demo** with sample data, because the official API isn't deployed yet: **[try it](https://jackhale98.github.io/ours/)**. You can [run your own](docs/SELF_HOSTING.md) today.

## What is protected, and what is not

Everything you write (event titles, times, notes, lists, check-ins, names) is encrypted on your device with keys the server never sees. The server stores ciphertext and relays it between your devices and your partner's.

The server **can** see, and this design does not hide:

- your account email address;
- how many records you have, roughly how large they are, and when they change;
- when your devices sync, and their IP addresses (in transit; never stored in the database);
- when reminders are scheduled to fire, and who notifies whom and when;
- your quiet-hours time zone, if you set quiet hours;
- busy blocks you choose to publish to the optional calendar feed;
- the address and contents of a calendar you subscribe to by link, while it relays them (never stored).

It also does **not** protect you against:

- **a compromised device or browser**: anyone who can use your unlocked device can read your plans;
- **malicious app code.** The web app is served from GitHub Pages. Whoever controls this repository or its Pages deployment could ship code that steals keys. Mitigations: the code is open source, `main` is protected with required reviews, CI actions are pinned by commit, and each release publishes build hashes so you can check what you are running.

If you lose all your devices **and** your 12-word recovery phrase, your data cannot be recovered by anyone, including the people running the server.

Key rotation after losing a device ([ADR 0013](docs/adr/0013-key-rotation.md)) is built but switched off until its security review ([0005](docs/reviews/0005-key-rotation.md)) is resolved. Removing a device signs it out immediately.

Full details: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). If something goes wrong on a server: [docs/INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md).

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
pnpm e2e             # Playwright (demo mode)
pnpm --filter @ours/web e2e:sync   # two browsers against a local Worker
```

## Running your own

Anyone can self-host on free tiers: see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

The official instance, once launched, is a free personal project run on a best-effort basis, with no uptime or support guarantees.

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md) — every commit needs a DCO `Signed-off-by` line.
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities.

## License

[AGPL-3.0-or-later](LICENSE). If you run a modified version as a service, you must offer its source to your users. See [ADR 0001](docs/adr/0001-license.md).
