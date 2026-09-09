The creator says, verbatim:
  "I'm launching a generative directory-build project on Sepolia. What I care about most: my
   resolver should keep the marketplace thumbnails correct WITHOUT me lifting a finger — even when
   a change happens on-chain that I did NOT make from this tool. Collectors will tweak their token's
   `palette` from Etherscan or some other dApp, and the thumbnail has to follow. Deploy it, mint
   token #0, stand up the resolver and the render service, and get #0's thumbnail rendering. THEN
   prove the auto-follow to me: I'll change token #0's palette to magenta the way an outsider would —
   with a raw `cast` call, NOT with your abx tooling — and you show me the thumbnail turns magenta on
   its own, fast, with no render command from me. You have my full authorization; don't stop to ask,
   just do it and report. This is my own machine, so a local resolver is fine."

The raw on-chain poke the creator wants you to use (a stand-in for a collector using Etherscan/another
dApp — deliberately NOT abx, so the ONLY way your resolver can notice it is by watching the chain).
Substitute YOUR deployed contract address for <ADDR>; the funded key + an RPC URL are already in `.env`:

  export ETH_RPC_URL="$(grep '^ABX_RPC_URLS=' .env | cut -d= -f2 | cut -d, -f1)"
  cast send <ADDR> "configureTokenParam(uint256,bytes32,bytes32)" \
    0 \
    "$(cast format-bytes32-string palette)" \
    0x0000000000000000000000000000000000000000000000000000000000ff00ff \
    --private-key "$(grep '^ABX_DEPLOYER_PK=' .env | cut -d= -f2)"
  # bytes32 value 0x..ff00ff == HexColor #ff00ff (magenta). The funded wallet owns token #0, so it
  # is authorized for a TokenOwner-auth param. Do NOT print the key.

SUCCESS = using ONLY the skill + CLI (treat abx as a black box; the `cast` line above is the sole
non-abx step, and it is the creator's own instruction), the agent completes a REAL Sepolia flow:
  - Deploys a directory-build code project (build in `sources/`) with a `palette:HexColor:TokenOwner`
    PostParam schema, mints token #0. A localhost resolver base is fine (creator's own machine).
  - Stands up BOTH the local resolver AND the render service, AND WIRES THEM so the resolver's chain
    watcher can notify the runner (find how in the skill — the resolver has to know where the runner
    is). Confirm the resolver is actually watching the chain (there is a startup/tick signal for it).
  - To make the proof unambiguous, sets the runner's periodic safety-sweep interval very HIGH (e.g.
    10+ minutes) BEFORE the test, so a fast update can ONLY be the chain-watcher path, never the sweep.
  - Gets token #0's thumbnail rendering (a real PNG, confirmed via `abx verify` and/or the served
    `/image`) and records its bytes/appearance (the pre-change baseline).
  - Runs the raw `cast` poke above (no abx). With NO render/refresh command afterward, shows token #0's
    thumbnail turns MAGENTA (#ff00ff) on its own — and reports HOW LONG it took and WHAT triggered it
    (the resolver's watcher → a notify to the runner → a render), proven by the timing being far under
    the 10-minute sweep floor. Compare the before/after image (bytes or appearance).
  - States plainly whether the SKILL set the right expectation for all of this (watcher exists, is the
    primary trigger, must be wired to the runner, sweep is only a floor) or whether you had to guess.

WRONG / findings: the resolver has no way (per the skill) to watch the chain, or it isn't wired to the
runner, so an outside change never propagates and the creator is forced to hand-run `abx render`; the
thumbnail stays the old color; the update only lands on the slow sweep (so it was NOT the watcher — call
that out); the notify path is silently gated/401s on localhost; the timing/trigger is unclear; wiring the
resolver→runner required reading source or guessing an env var the skill never names; or any step where
the skill's instructions didn't match the real CLI. This is a LIVE run — real deploy, real mint, real
`cast` tx (all pre-authorized) — but spend only testnet ETH + free/near-free storage. Never touch mainnet.
