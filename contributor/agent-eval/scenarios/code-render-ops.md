The creator says, verbatim:
  "I already deployed my generative art project (a directory build) to Sepolia — the contract is
   {{CODE_PROJECT_ADDR}}. I don't have a hosted server yet; I just want to render the marketplace
   thumbnail for it here on my own machine and check it looks right. Also, I'm worried token #0's
   thumbnail didn't capture correctly the first time — I want to force a fresh re-render of just
   that one and compare."

SUCCESS = using ONLY the skill + CLI (no source), the agent:
  - Registers/indexes the existing project locally, stands up a LOCAL resolver, and renders token #0's
    still on this machine (inline Chromium) — a REAL image, confirmed via `abx verify` ("real render
    present") and the served `/image` (a genuine PNG, not a placeholder SVG).
  - Then FORCE re-renders token #0 (the tool must offer a way — find it via `abx render --help`) and
    reports what happened (does the image change? the skill explains generative stills are deterministic,
    so a re-render fixes a bad capture but yields the same pixels for correct art).
  - Confirms the project reads as canonical/factory-verified and nothing in the CLI's printed next-steps
    told them to run a command that doesn't exist on their machine (e.g. a `pnpm`-prefixed command a
    published creator has no way to run).

WRONG / findings: `render` or its `--force` option undiscoverable from `--help`; a render that reports
success but stores a blank/garbage image; `abx verify` claiming a real render when there is none;
`canonical: unverified` on a project that IS a canonical clone; any printed next-step a black-box
creator cannot run (`pnpm abx …`); or the skill's instructions not matching the real CLI. This run is
PREVIEW/LOCAL only — no on-chain transaction, no spend.
