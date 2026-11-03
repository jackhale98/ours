# Contributing

Thanks for helping. A few rules keep the project safe to trust.

## Developer Certificate of Origin

Every commit must be signed off, certifying the [Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "Describe the change"
```

This adds `Signed-off-by: Your Name <you@example.com>`, which must match the commit author email. CI rejects pull requests with unsigned commits. There is no CLA. Signed commits (GPG/SSH) are encouraged and required for maintainers.

## Before you open a pull request

- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:api` pass.
- New logic has tests. Changes to `packages/core/crypto`, auth or scope enforcement need review by someone other than the author, focused on security.
- Works at 360 px wide and on desktop, keyboard only, in light and dark themes.
- No new runtime third-party requests. Initial JS stays within budget (`node scripts/check-bundle.mjs`).
- New dependencies: justify in the PR (maintenance, size, license); the license must pass `pnpm check:licenses`.
- Any new stored field is added to `docs/THREAT_MODEL.md` and the privacy policy.
- Non-obvious decisions get an ADR in `docs/adr/`.
- Source files start with `// SPDX-License-Identifier: AGPL-3.0-or-later` (`pnpm check:spdx`).

## Ground rules for crypto

Never hand-roll primitives. Only `packages/core/crypto` touches keys or ciphertext. Use the existing labels in `crypto/kdf.ts` and add a new one for any new purpose. Changing a label or AAD layout is a breaking protocol change and needs an ADR.
