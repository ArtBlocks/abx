---
'@artblocks/abx-cli': patch
'@artblocks/abx-sdk': patch
---

Recover ambiguous creator-wallet submissions through the existing operation status instead of replaying them. Sponsored sends now keep polling safely when the provider response is temporarily unknown and surface the operation ID if reconciliation cannot complete.
