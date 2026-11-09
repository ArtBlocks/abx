---
"@artblocks/abx-cli": minor
---

Add `abx preview --check`, which renders each seed in fresh browser contexts (3 runs by default, `--runs`; `--frames <k>` compares k frames per run for animated pieces) and reports pass, drift, or harness failure with exit codes 0, 1, and 2. Requires completion, rejects failed captures, compares normalized traits at every sampled frame, and collects diagnostics through the final capture. Honors `--json`, including harness errors. Results are bounded evidence for the tested runtime and inputs, not a proof of determinism.
