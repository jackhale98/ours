# 0005. Lint and format: Biome

- Status: Accepted
- Date: 2026-11-03

## Decision
Biome (one fast binary, one config) instead of ESLint + Prettier. Recommended rules plus: no non-null assertions, `import type` required, no `console.log` (only `warn`/`error`). Markdown is not formatted.

## Consequences
Fewer plugins than ESLint (no a11y lint for JSX beyond Biome's built-in a11y rules); accessibility is enforced by axe in E2E and Lighthouse.
