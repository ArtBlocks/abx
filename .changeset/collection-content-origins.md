---
"@artblocks/abx-sdk": minor
"@artblocks/abx-token-api": patch
"@artblocks/abx-cli": patch
---

Serve resolver project documents on collection-scoped content origins configured by
ABX_CONTENT_DOMAIN. Preserve existing metadata and animation URLs, provide marketplace-compatible
live-view wrappers and canonical direct links, and keep artifact bytes unchanged across redirects.
Self-hosted documents use opaque-origin sandboxing when no content domain is configured. Advertise
content addressing in service discovery and document the browser storage and wallet implications.
