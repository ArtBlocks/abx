---
"@artblocks/abx-sdk": minor
"@artblocks/abx-cli": minor
---

Add automatic creator-wallet payment: sufficiently funded wallets pay native value and network
fees; eligible zero-value calls otherwise use sponsorship. Introduce `--embedded` with `--sponsor`
as its backwards-compatible alias, reuse one agent grant, and verify returned signing payloads
against the local transaction intent before signing. Self-payment requires live provider support.
