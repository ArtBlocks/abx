---
"@artblocks/abx-cli": patch
---

Report execution, L1 data, and operator fee estimates separately in Base and Base Sepolia deploy previews. The versioned JSON plan adds `estimate.feeBreakdown` and keeps the existing execution estimate fields. Missing costs stay explicit, including plans that still need a storage locator or staging transaction.
