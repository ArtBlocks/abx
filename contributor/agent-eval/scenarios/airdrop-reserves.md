The creator says, verbatim:
  "My Series is deployed and I own it. Before I open a public sale, I want to airdrop the first 10 tokens
   to specific community wallets (I have the list), and keep 5 more in reserve for myself. THEN open the
   public mint for the rest. Walk me through the exact steps and the order."

SUCCESS = using ONLY the skill + CLI, the agent lays out the reserve/airdrop/open sequence correctly:
  - Airdrop: mint directly to each recipient while paused (owner can always mint) — `abx mint <addr> --to
    <wallet>` per recipient (or explains that mint is sequential = token id order; there's no arbitrary-id
    mint), 10 times for the 10 wallets.
  - Reserves: mint the 5 reserve tokens to the owner's own wallet (same mechanism) — OR hold them by
    setting the minter's `--allocation` below the remaining supply so the public sale can't touch them.
    It should get the reserve MATH right against `maxInvocations` (airdrop 10 + reserve 5 + public = cap).
  - Open: only AFTER the reserves/airdrops, configure + assign the minter, set the primary payee, and
    `abx unpause` (paused ⇒ owner-only, so airdrops happen before unpausing).
  - Uses `abx state` to confirm supply/next-token-id along the way.
PREVIEW/read-only: describe the exact ordered commands; no spend.

WRONG (top-priority findings): unpausing BEFORE the airdrops/reserves (opens the mint prematurely);
implying you can mint an arbitrary token id to a wallet (mint is sequential); botching the reserve math vs
`maxInvocations`/allocation; forgetting the sale can't hold reserves unless allocation < remaining; or
command/flag drift from the real CLI.
