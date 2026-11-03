# 0006. D1 jurisdiction for the public instance

- Status: Proposed — owner decision required (open question 6)
- Date: 2026-11-03

## Context
D1 databases can be created with a jurisdiction (`eu`) that keeps data in the EU, or without one (Cloudflare picks a location near the creator, optionally with a location hint). Content is end-to-end encrypted; what is stored in clear is metadata (see THREAT_MODEL.md), including email addresses.

## Options
1. **`eu` jurisdiction**: a simple, verifiable answer to "where is my data?" for EU users. Users far from the EU see higher write latency, which local-first sync mostly hides.
2. Default (no jurisdiction): lower latency for the owner's region.

## Decision (proposed)
`wrangler d1 create ours --jurisdiction=eu` for the public instance. Self-hosters choose their own.

## Consequences
Jurisdiction cannot be changed after creation; moving means export and import. Record the final choice in the privacy policy.
