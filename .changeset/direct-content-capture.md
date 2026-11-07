---
"@artblocks/abx-sdk": patch
"@artblocks/abx-token-api": patch
"@artblocks/abx-effects": patch
"@artblocks/abx-cli": patch
---

Effects runners capture direct collection content URLs from ABX_CONTENT_DOMAIN or remote service
discovery. This keeps browser navigation status checks on the actual document and avoids marketplace
wrappers in automated capture. Document the shared resolver/effects configuration in the bundled skill.

Top-level browser live-view requests use HTTP redirects so existing capture clients see the final
artwork status. Marketplace frames and server-side downloads retain the embeddable wrapper.
