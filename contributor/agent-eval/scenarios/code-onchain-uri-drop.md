The creator says, verbatim:
  "I want a FULLY on-chain generative art NFT — the real deal. No server, no resolver, no IPFS
   gateway in the picture. When someone reads my token's tokenURI straight from the contract, EVERYTHING
   they need to see the art has to come back from the chain itself. My p5 sketch is in
   `sources/p5-dep-proof/sketch.js`. Deploy it fully on-chain on Sepolia, mint token #0, and then PROVE
   to me it's truly self-contained: read the tokenURI with a raw `cast call` — no abx, no server running —
   and show me it decodes to a working artwork with p5 coming from the chain, not a CDN. Then show me a
   collector can change a param (my sketch tints from a `palette` color) and the pure-chain tokenURI
   follows, still with nothing running. You have my full authorization; don't stop to ask — deploy, mint,
   prove it, report. Testnet only."

SUCCESS = using ONLY the skill + CLI (treat abx as a black box; the single raw `cast call`/`cast send`
below is the creator's own instruction — everything else is abx), the agent completes a REAL Sepolia flow:
  - Discovers the fully-on-chain lane from the skill (the tokenURI is served on-chain, so NO
    `--public-base-url` / resolver is required — that's the whole point). Deploys the TEMPLATE-mode p5
    sketch on this lane with the p5 dependency, minting token #0. CRUCIAL: the p5 dep must resolve to
    ON-CHAIN bytes, not a CDN — the skill should make clear that a CDN-only dependency would put a URL in
    the graph and break "fully on-chain." Give the token a `palette` PostParam schema so a collector can
    tint it.
  - Runs `abx verify` and it reports the drop is **chain-complete** — template branch, every dependency
    resolves to proven on-chain bytes, no server/gateway/CDN in the graph, nothing over the URL budget.
    Quote that readout.
  - Proves it independently with a RAW pure-chain read (no abx, no server anywhere):
      export ETH_RPC_URL="$(grep '^ABX_RPC_URLS=' .env | cut -d= -f2 | cut -d, -f1)"
      cast call <ADDR> "tokenURI(uint256)(string)" 0
    Decode the returned `data:application/json...` → its `animation_url` is a `data:text/html...` document →
    decode THAT and show it is self-contained: p5 rides as an inline (gzip) data-URI, and there is NO
    `http(s)://` fetch for the dependency anywhere in the document. Bonus: execute the document (headless
    Chromium) and confirm the sketch runs / reports its traits.
  - Then the collector-follow proof, still pure-chain. Change the palette (the funded wallet owns #0, so a
    TokenOwner-auth param is allowed) — via `abx configure-param` — and show the new palette landing in
    TWO pure-chain reads: `cast call tokenParam(uint256,bytes32)` (or `abx tokens <addr>`) returns it
    straight from the param store, AND the NEXT raw `cast call tokenURI(uint256) 0` carries it inside the
    `animation_url` document's tokenData (and, if rendered, the art tints to it). Params are NOT projected
    into the metadata JSON — the store is the surface. PostParams flowing through ZERO servers is the
    thing to demonstrate.
  - States plainly whether the SKILL set the right expectations: what makes a drop chain-complete, that
    only on-chain deps keep it so, that no resolver is needed for this lane, AND that the static
    marketplace thumbnail (`image`) is a SEPARATE concern (still the effects runner's job — `abx verify`
    should say the thumbnail is a placeholder until you render one). Note anything you had to guess.

WRONG / findings: no discoverable fully-on-chain lane (the skill implies code ALWAYS needs a resolver);
deploy refuses / demands `--public-base-url` even on this lane; `abx verify` doesn't report
chain-completeness, or claims chain-complete while the raw tokenURI actually contains an `http(s)` CDN or
gateway URL for the dependency (a false green — call it out loudly); the dependency ends up served from a
CDN without any warning that this breaks "fully on-chain"; the param change does NOT appear in the
subsequent pure-chain tokenURI; the skill conflates the on-chain tokenURI with the thumbnail (claims the
image is on-chain too); or any step where the skill's instructions didn't match the real CLI. This is a
LIVE run — real deploy, mint, and param tx (all pre-authorized) — but spend only testnet ETH. Never touch
mainnet. Never print secrets.
