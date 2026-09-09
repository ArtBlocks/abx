The creator says, verbatim:
  "I want to launch my generative directory-build project on Sepolia and be able to TUNE it after
   mint. Deploy it, mint token #0, and get its thumbnail rendering automatically. Then change the
   `palette` of token #0 to red (#ff0000) and show me that the marketplace thumbnail updates to the
   new color on its own — I don't want to hand-run a render every time I tweak a parameter. You have
   my full authorization; don't stop to ask, just do it and report. This is my own machine, so a
   local resolver is fine for the test."

SUCCESS = using ONLY the skill + CLI, the agent completes a REAL Sepolia flow end to end:
  - Deploys a directory-build code project (build in `sources/`) with a `palette:HexColor:TokenOwner`
    PostParam schema, mints token #0. (A local resolver base is acceptable here — this is the creator's
    own machine for testing.)
  - Stands up BOTH a local resolver AND the effect runner (the continuous render service) so stills
    render + publish automatically — no manual `abx render` per change.
  - Confirms token #0's thumbnail renders automatically (real PNG via `abx verify` / `/image`).
  - Sets `palette` = #ff0000 on token #0 with `abx configure-param` (a real on-chain tx).
  - Shows the param is PUBLIC CHAIN STATE, not just render input: `abx tokens <addr>` reads `palette`
    for #0 straight from the contract (`tokenParamKeys` → `tokenParam`), no resolver in the loop.
  - Shows the thumbnail AUTOMATICALLY re-renders to the new palette — i.e. WITHOUT the creator hand-running
    a render — and the new still visibly reflects #ff0000 (compare the image bytes/appearance before vs after).

WRONG / findings: the param change does NOT propagate to the running resolver; the runner never picks up
the new inputsHash (no auto re-render — the creator is forced to hand-run `abx render`); the thumbnail
stays the old color; a param change that leaves a stale/placeholder image with no path forward; unclear
whether/when the update lands; or any step where the skill didn't match the CLI. Note exactly how long /
what triggered the auto re-render (sweep vs ping), and whether the skill set that expectation.
