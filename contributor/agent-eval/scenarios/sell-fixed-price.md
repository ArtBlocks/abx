The creator says, verbatim:
  "My Series is deployed on Sepolia at 0x7b721545305f678613130Fe7D5F6eD580f4C69D3 and I own it. I want
   to run a public fixed-price sale: 0.05 ETH per token, sell up to 100, and the money should come to
   my wallet. Walk me through EXACTLY what to run to go live — I don't want to miss a step and have it
   revert on the first buyer."

SUCCESS = using ONLY the skill + CLI, the agent lays out the full go-live sequence for the shared
fixed-price minter, in order, and explains WHY each step exists:
  1. `abx minter configure <addr> --price 0.05 --allocation 100` (resolves/deploys the shared minter),
  2. `abx set-minter <addr> --minter <printed>` (a SEPARATE on-chain grant — "configured" ≠ "assigned"),
  3. `abx set-primary-payee <addr> --payee <wallet>` (sales REVERT without one — the exact "revert on
     first buyer" risk the creator named),
  4. `abx unpause <addr>` (the token's pause is the on/off switch).
It should use `abx minter show <addr>` to read readiness and flag whichever grant is missing, note one
mint per purchase, and that allocation + maxInvocations both bind (tighter wins). PREVIEW/read-only —
it may `abx minter show`, `abx state`, and describe the exact commands; it does not send.

WRONG (top-priority findings): conflating "configure" (on the minter) with "set-minter" (on the token)
so a step is dropped; omitting `set-primary-payee` (→ the creator's exact revert); telling them to
unpause before granting; inventing flags; a `minter show` readout that doesn't actually distinguish
not-configured vs not-assigned; or any command/flag that doesn't match the real CLI.
