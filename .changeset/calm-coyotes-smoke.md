---
'@artblocks/abx-cli': patch
---

Classify env-key signing risk from the shared chain registry so newly supported testnets, including
Robinhood Chain Testnet, work in bounded autonomous smoke tests without being mistaken for mainnet.
The contributor smoke runner now pins one testnet, gives the worker a fresh small-funded wallet,
copies only the requested hosted-provider credential, and records evidence without per-transaction
prompts. Remote discovery accepts `remote list`, and on-chain image planning now calls out the
single-transaction inline-SVG alternative when it applies.
