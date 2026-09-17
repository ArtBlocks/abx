---
'@artblocks/abx-cli': patch
---

Add machine-readable `--json` output to `contracturi` and `add`. Collection metadata reads now emit
the resolved document alone, while registration reports identify the target surface, chain and
address, scan floor, lifecycle status, and whether remote catch-up is complete or still backfilling.
