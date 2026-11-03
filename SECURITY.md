# Security policy

Ours is end-to-end encrypted software. We take reports seriously and credit reporters who want credit.

## Reporting a vulnerability

- Preferred: open a **private security advisory** on this repository (Security → Advisories → Report a vulnerability).
- Or email the security contact listed on the public instance's `/privacy` page. *(Owner: publish the address before launch; see the open questions in docs/ARCHITECTURE.md.)*

Please include steps to reproduce, affected versions or commits, and the impact you believe it has. Do not test against other people's accounts or data.

## What to expect

- Acknowledgement within 7 days.
- A fix or mitigation plan within 30 days for high-severity issues.
- Coordinated disclosure: we will agree a date with you, normally within 90 days.

## Scope

In scope: `packages/core/crypto`, authentication and authorisation in `apps/api`, scope enforcement (one user reading another's private records), the invite and recovery flows, and anything that exposes plaintext or keys to the server.

Known limitations that are **not** vulnerabilities are listed in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) (for example, metadata visible to the server).
