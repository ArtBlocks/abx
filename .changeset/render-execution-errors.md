---
"@artblocks/abx-effects": patch
---

Drop-in correctness fix for render-effect users: refuse image and trait outputs after uncaught document exceptions or page crashes. Healthy scripts keep the existing bounded completion fallback, and console diagnostics alone remain nonfatal.
