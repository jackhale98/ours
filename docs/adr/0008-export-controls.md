# 0008. Encryption export rules

- Status: Accepted (engineering note, not legal advice)
- Date: 2026-11-03

## Context
US Export Administration Regulations cover encryption software. Since the March 2021 rule change, publicly available encryption source code that uses standard cryptography generally qualifies for the "publicly available" exclusion without the former email notification to BIS and NSA (15 CFR 734.3(b)(3), 734.7, 740.13(e), 742.15(b)). The notification requirement remains for "non-standard cryptography".

Current text: https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-742/section-742.15 and BIS guidance at https://www.bis.gov/. Check these before each major release; the rules change.

## Decision
- Use only standard, published algorithms (XChaCha20-Poly1305, HKDF-SHA256, SHA-256, BIP39) from audited open-source libraries.
- Keep the full source public.
- Never introduce custom or non-standard cryptography.

## Consequences
Any proposal for a new primitive must update this ADR and be checked against current BIS guidance first.
