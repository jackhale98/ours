# 0002. Package manager: pnpm workspaces

- Status: Accepted
- Date: 2026-11-03

## Context
The plan asks for npm or pnpm workspaces. During scaffolding, npm 10.9 crashed (`Cannot read properties of null (reading 'edgesOut')`) resolving Vitest 4.1's optional peer dependencies, reproducibly, even from a clean tree.

## Decision
pnpm 10 via Corepack (`packageManager` field), `pnpm-workspace.yaml`, exact versions (`save-exact`), frozen lockfile in CI.

## Consequences
- Contributors run `corepack enable` once. CI does the same; no extra GitHub Action is needed.
- pnpm's strict `node_modules` catches undeclared dependencies.
- License checks use `pnpm licenses list`, so no extra checker dependency is needed.
