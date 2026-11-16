---
"@artblocks/abx-sdk": patch
"@artblocks/abx-cli": patch
---

Code deployment previews no longer report "RPC unreachable" when a chain simply has no dependency
registry pointer; the chain-complete expectation now says the registry dependency cannot resolve
fully on-chain and why.
