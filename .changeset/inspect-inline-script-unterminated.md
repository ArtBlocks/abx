---
"@artblocks/abx-sdk": minor
"@artblocks/abx-cli": patch
---

Drop-in for existing SDK consumers: `analyzeScript` adds an optional `inlineHtml` finding and the SDK exports `inlineScriptUnterminatedAt`. Detect raw script content that the current generated HTML cannot terminate. The CLI warns during inspect, ERC-721/ERC-1155 script deployment, and script replacement without executing or rewriting the source. Document context-specific author fixes and previewing before locking. No contract or generator behavior changes.
