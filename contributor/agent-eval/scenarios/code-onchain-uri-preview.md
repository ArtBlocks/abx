The creator says, verbatim:
  "Before I spend a single cent I want to understand my options for going fully on-chain. I've got a p5
   sketch in `sources/p5-dep-proof/sketch.js`. Can it be FULLY on-chain — tokenURI and all — with this
   tool? Which dependencies can actually live on-chain versus only on a CDN, and what does that choice
   mean for me? Show me a complete DRY-RUN preview of a fully-on-chain deploy: what it would write, what
   makes it count as 'fully on-chain' or not, and a rough cost if you can. Then show me the flip side —
   if I picked a dependency that's only on a CDN, does the tool WARN me my drop won't really be fully
   on-chain? I haven't set up any signing key yet, so keep this all preview. Tell me exactly what I'd
   need to do a real one."

SUCCESS = using ONLY the skill + CLI (treat abx as a black box; no source), PREVIEW ONLY — no on-chain
transaction, deploy, mint, or spend — the agent:
  - Discovers from the skill BOTH the fully-on-chain lane (on-chain tokenURI, no resolver base needed)
    and the dry-run / preview affordance. Runs a dry-run of a fully-on-chain deploy of the template
    sketch with the p5 dependency and reads back a clear plan: the lane in use, the DEPENDENCY RESOLUTION
    report (does p5 resolve to on-chain bytes on THIS chain's registry, or only a CDN?), what legs get
    written (the generator as the animation field renderer, the tokenURI renderer, the contractURI
    renderer), the chain-complete expectation, and — bonus, never required — a rough cost. Quote the
    readout.
  - Exercises DEPENDENCY SELECTION as a real decision. Pick (or preview) a dependency that is NOT on-chain
    on this chain — e.g. a large lib that the registry only lists a CDN for — and confirm the tool tells
    the creator, BEFORE any spend, that this choice resolves via a CDN and therefore the drop would NOT be
    fully on-chain (a URL enters the graph). The question under test: can a creator tell from the PREVIEW
    whether their dependency choice yields a chain-complete drop?
  - Explains the model back in plain terms: template + all-on-chain deps = fully on-chain (chain-complete);
    any CDN dependency, or the directory-build style, means a URL/gateway is in the graph (not fully
    on-chain); and directory-build's param delivery carries a size budget (~8KB of params through the URL)
    that the tool should warn about rather than silently truncate.
  - States plainly whether the dry-run readout gave enough to DECIDE without spending, and exactly what
    blocks a real deploy from here (a funded signing key / `--sign` etc.).

WRONG / findings: the dry-run doesn't distinguish a fully-on-chain drop from a CDN-dependent one; the
dependency report never says whether a given dep is on-chain vs CDN on THIS chain; the fully-on-chain lane
can't be previewed without a key; no cost guidance even when it could be given; the directory-build ~8KB
param budget is never surfaced anywhere; the skill doesn't cover the lane or the dependency distinction;
or any place a documented command/flag didn't match the real CLI. PREVIEW ONLY — if you cannot preview
something without spending, that itself is a finding, not a reason to spend. Never print secrets.
