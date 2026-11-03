# 0004. Sync: custom encrypted record sync

- Status: Accepted
- Date: 2026-11-03

## Context
The plan asks for a time-boxed evaluation of existing local-first E2EE sync frameworks (Evolu, Jazz, Automerge with an encrypted relay) before building custom sync. Criteria: relay runs on Cloudflare Workers/D1 or another free self-hostable host; fits the 90 KB initial-JS budget; actively maintained.

This was a desk evaluation (documentation, package metadata, architecture), not a running prototype. Package data checked 2026-11-03.

| Option | Maintained | Relay on Workers/D1 | Bundle | Fit |
|---|---|---|---|---|
| Evolu (`@evolu/common` 8.26) | Yes, active | Ships its own relay (SQLite-based, Node-first); a Workers/D1 port would be ours to maintain | Includes SQLite-in-WASM on the client — well above our whole JS budget | E2EE is built in, but it brings its own key management, which would replace our pairing/recovery design |
| Jazz (`jazz-tools` 0.20) | Yes, pre-1.0 | Self-hostable sync server, not Workers/D1 | Large; CoValue runtime | Its own account and permission model; pre-1.0 API churn |
| Automerge 3.5 + encrypted relay | Yes | Relay is simple, but we would write it | WASM core, several hundred KB | CRDT history is overkill for two writers and small records; encrypting change chunks loses most of its sync efficiency |

## Decision
Use the plan's custom record sync: per-record envelopes, server-assigned revisions from a per-space sequence, `base_rev` conflict detection, LWW with authenticated timestamps, and field-wise merge for list items and settings (`packages/core/sync`).

## Consequences
- We own correctness of a small protocol; it is covered by unit tests and will be covered by Worker integration tests (phase 2) and a two-browser E2E (phase 3).
- No real-time collaboration on the same text field; fine for two people and short fields.
- Revisit if requirements grow (groups > 2, rich shared text).
