# 0001. License: AGPL-3.0-or-later

- Status: Accepted (provisional — owner to confirm, open question 1)
- Date: 2026-11-03

## Context
The plan recommends AGPL-3.0 so hosted forks stay open, with MIT acceptable. The public instance is a network service; users of a modified hosted fork should be able to get its source, because trust in an E2EE web app rests on being able to inspect the code that handles keys.

## Options
1. **AGPL-3.0-or-later**: network copyleft. Hosted forks must offer source.
2. MIT: maximal reuse, including closed hosted forks.

## Decision
AGPL-3.0-or-later for the whole repository, with SPDX headers in every source file (enforced by `pnpm check:spdx`). Dependencies must be permissively licensed (see `scripts/license-policy.json`), which is compatible.

## Consequences
- Some companies avoid AGPL dependencies; `packages/core` could later be relicensed MIT by its contributors if reuse matters. With a DCO and no CLA, relicensing needs every contributor's agreement, so decide early.
- If the owner chooses MIT instead: replace `LICENSE`, the `license` fields, and the SPDX headers (one `sed`).
