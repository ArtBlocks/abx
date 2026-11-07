---
"@artblocks/abx-sdk": patch
"@artblocks/abx-indexer": patch
"@artblocks/abx-token-api": patch
"@artblocks/abx-cli": patch
"@artblocks/abx-effects": patch
---

Keep transport configuration out of public project state; bound project-content fetching to public network destinations and limited decoded bodies. Authenticate local signing sessions, verify completed transaction intent, contain preview file reads, preserve queued indexer deltas, and require authentication for public effects listeners. Scope deterministic image writes to their collection and document reference hosting limits and migrations.
