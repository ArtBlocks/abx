---
'@artblocks/abx-effects': patch
---

`abx-effects --help` and `-h` now print usage and exit instead of starting the runner, `--version` and `-v` print the package version, and an unrecognized argument exits with an error and usage instead of starting the HTTP server and sweep loop. `--once` and the no-argument runner are unchanged.
