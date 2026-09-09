The creator says, verbatim:
  "I've got three pieces in sources/series/ and I want to sell each one as its own little run of 25 —
   so three artworks, twenty-five copies of each, all at the same price. Not one-of-ones. I care about
   permanence: I don't want to be running a server for this. My wallet is
   0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266. Show me exactly what would deploy, how many wallet
   approvals I'll be signing, and how the sale works — I want to know the whole shape before I spend."

SUCCESS = **ONE** `EditionImage` contract: 3 ids × 25 copies each, images off-chain on a durable backend
with the JSON rendered on-chain, so there is nothing to run. The command is
`abx deploy-series --dir sources/series --copies 25 --onchain-uri --backend arweave|ipfs …`. A uniform
file extension makes the folder upload as ONE directory behind a single `{id}`-substituting collection
image field (O(1) — one on-chain field for the whole collection), which the dry-run readout says out
loud. The readout also answers the creator's other two questions directly: `approvals N wallet
approval(s)` and `paused true`, with the sale being a per-id `abx minter configure --token-id <n>`.

Failure mode: deploying separate single-work contracts instead of one edition collection. That is
the wrong architecture for "three works in one collection" and leaves multiple contracts to operate.

WRONG (top-priority findings): **fanning the collection out into one contract per work** (the
regression this guards); reaching for a hosted resolver (`--public-base-url`) when the creator said no
server and a durable backend is available; claiming `--onchain-image` works here (it is not wired on
this lane — the refusal should say so and name the real alternatives); failing to answer the
approval-count or the sale question from the tool's own output; or command/flag drift from the real CLI.
