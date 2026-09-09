The creator says, verbatim:
  "I already deployed a generative directory project to Sepolia — contract
   0xC65DE7E2143880bb1959db7bFA526Fb3bE07Cc64 — and it has 4 tokens minted. I'm setting up a fresh
   resolver box for it and I want a dependable ANSWER to one question: are all four tokens' marketplace
   thumbnails up to date right now, or are some stale / mid-render / failed? Get my resolver serving
   this project, get the thumbnails rendered, and show me a clear per-token status readout I can trust —
   and walk me through what it looks like WHILE the renders are catching up, so I know the difference
   between 'still working on it' and 'something's wrong'. I don't want to eyeball four image URLs by hand."

SUCCESS = using ONLY the skill + CLI (treat abx as a black box; no source), the agent:
  - Registers/indexes the existing project on a LOCAL resolver and stands up the render service so the
    four stills render + publish (inline Chromium or the local runner — no cloud, no spend).
  - Finds and uses the tool's PER-TOKEN effect-status readout (there is a status surface — discover it
    from the skill / `abx verify --help`): reports each token as up-to-date / rendering / failed / stale,
    plus the roll-up counts, and confirms it reaches 4/4 up-to-date once rendering completes.
  - Captures the status DURING catch-up too: on a fresh box the tokens start stale, move through
    rendering, then land up-to-date. Quote the readout at ≥2 points in time so the progression is visible.
    Explain how a genuinely FAILED render would look different from one that's merely still rendering.
  - Sanity-checks that the readout is TRUTHFUL: cross-check at least one token the status calls
    "up-to-date" against its actual served `/image` (a real PNG, not a placeholder SVG), and confirm a
    token still shown "stale" really has no render yet. Note any mismatch between the status and reality.

WRONG / findings: no discoverable per-token status readout (the creator is left curl-ing image URLs by
hand); the status claims "up-to-date" for a token whose `/image` is still a placeholder (or "stale" for one
that clearly rendered); rendering vs failed are indistinguishable; the counts don't add up; the status
never converges to 4/4 even though the images render; the skill doesn't mention the status surface or
`abx verify --remote`; or any step where the skill's instructions didn't match the real CLI. This run is
PREVIEW/LOCAL only — indexing, serving, and rendering are free and allowed, but do NOT send any on-chain
transaction (no deploy, mint, or param change). Never print secrets.
