---
"@artblocks/abx-cli": minor
---

Report conservative signing readiness in dry-run command results without extra RPC calls, credential-store access, authorization refresh, or transactions. Preserve the existing version-3 deploy plan; prepared writes reuse their existing execution/funding simulation.

Refuse `demo --dry-run` before it enters the live walkthrough; direct callers to the supported deployment-preview command.
