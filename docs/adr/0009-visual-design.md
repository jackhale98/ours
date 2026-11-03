# 0009. Visual design tokens and fonts

- Status: Accepted
- Date: 2026-11-03

## Context
The owner supplied `docs/prototype.html` as the visual reference. The plan requires self-hosted fonts (2 faces max, WOFF2, swap, preload the primary), no runtime third-party requests, and WCAG 2.2 AA contrast in light and dark themes.

## Decision
- Tokens copied from the prototype into `apps/web/src/styles/tokens.css`, renamed by role (`--person-a`, `--person-b`, `--ours`) instead of by sample name.
- Two failing tokens adjusted (`--faint` for text; new `--control` for control borders). `scripts/check-contrast.mjs` (CI: `pnpm check:contrast`) checks 28 colour pairs per theme.
- Fonts: Figtree (body, preloaded, 20 KB) and Bricolage Grotesque (display, 41 KB), Latin subsets of the variable `wght` axis from Fontsource 5.3.0, vendored in `apps/web/src/fonts/` with their OFL-1.1 licence text. Bricolage's optical-size axis is dropped to save bytes.
- Fonts are vendored rather than installed from npm so the build has no font dependency and the license allowlist (OFL for fonts only) applies to files we can see.

## Consequences
- `--faint` text is close to `--muted`; hierarchy comes from size and weight more than colour.
- Non-Latin text falls back to system fonts. Add more subsets (Latin Extended is ~+15 KB per face) if users need them.
- Updating fonts means replacing two files and their notice in THIRD_PARTY_NOTICES.md.
