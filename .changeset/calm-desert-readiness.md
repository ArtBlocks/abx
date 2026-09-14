---
'@artblocks/abx-cli': patch
---

Make release-candidate automation fail closed: accept the documented hot-signing flag for code
editions, simulate purchase dry-runs as the configured hot signer, and return a failed exit status
when any requested render fails.
