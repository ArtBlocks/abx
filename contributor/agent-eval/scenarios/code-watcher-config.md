The creator says, verbatim:
  "I have a generative project on Sepolia — contract 0x7098bE19f29B204d7864826Fa1C0C02E86b2b4e9. I keep
   hearing my resolver can 'watch the chain' and keep thumbnails fresh automatically, even when changes
   come from other tools, not just from me. I want to understand and turn that on: get my resolver
   running and watching THIS contract, prove to me it's actually watching (not just sitting there), and
   explain in plain terms what will happen when something changes on-chain — how fast, and what the moving
   parts are. Also tell me what I'd need to set up if this resolver were public on the internet instead of
   on my laptop. Don't change anything on-chain — I just want it set up and explained."

SUCCESS = using ONLY the skill + CLI (treat abx as a black box; no source), the agent:
  - Indexes the contract on a LOCAL resolver and starts the resolver so its chain WATCHER is running,
    then SHOWS the creator concrete evidence it is watching — the startup banner naming the watch, and a
    poll/tick log line proving it is repeatedly checking the chain (quote them). If a knob controls the
    watch cadence, name it and its default.
  - Explains, correctly and in plain terms, the auto-update model this project would follow: an on-chain
    change (a param edit, a new mint — from ANY tool, not just abx) → the resolver's watcher notices it on
    its next poll → it tells the render service "something changed here" → the still re-renders. Names the
    primary trigger (the watcher) vs the periodic sweep (a safety floor, not the main path), and gives a
    realistic sense of latency.
  - Covers the PUBLIC posture: what changes when this resolver is exposed on the internet rather than
    localhost — how the resolver↔runner link is secured (the token that gates the runner's endpoints), and
    that a public runner must be reachable + gated. Pull this from the skill, not from guessing.
  - Flags any place the skill or `abx <cmd> --help` (serve / effects / deploy-effects) does NOT actually
    describe the watcher, or names a flag/env var that doesn't exist, or where the running CLI's behavior
    didn't match what the docs promised (e.g. the banner/log the skill implies is missing).

WRONG / findings: the watcher can't be confirmed running (no banner, no tick log) so the creator can't tell
it's working; the skill never explains the watch → notify → render chain, or gets the trigger wrong (calls
the sweep the primary path); the cadence knob is undocumented or wrong; the public-facing gating (the
runner token) is unexplained or misnamed; `abx serve --help` / `effects --help` don't mention the watcher at
all so a creator would never discover it; or any place the skill's instructions didn't match the real CLI.
This run is PREVIEW/LOCAL only — indexing and serving are free and allowed, but do NOT send any on-chain
transaction (no deploy, mint, or param change). Never print secrets.
