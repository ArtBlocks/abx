---
"@artblocks/abx-indexer": patch
---

Default recovery and backfill requests on a watched node retain its recorded scan boundary, including manual retries. Reject lagging endpoints before historical scans without adding work to healthy delta folds.
