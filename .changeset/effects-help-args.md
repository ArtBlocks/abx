---
'@artblocks/abx-effects': patch
---

`abx-effects --help` and `-h` now print usage and exit instead of starting the runner, and an unrecognized first argument exits 1 with usage instead of starting the HTTP server and sweep loop. `--once` and the no-argument runner are unchanged.
