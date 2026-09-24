---
'@artblocks/abx-cli': patch
---

Make sponsored deployment previews resolve the existing ABX creator wallet without provisioning external state, so the preview and real send use the same owner, mint recipient, and deterministic salt.
