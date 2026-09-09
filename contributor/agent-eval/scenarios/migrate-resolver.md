The creator says, verbatim:
  "I've been running a hosted resolver for my off-chain collection, but I want to move it to a new host
   (fresh machine, empty store) without breaking the live NFT or losing my off-chain metadata. How do
   I move it safely, and how does the cutover work so collectors never see a broken token?"

SUCCESS = using ONLY the skill + CLI, the agent explains the resolver→resolver move:
  - Stand up the new resolver, then **`abx migrate <addr> --from <old-url> --to <new-url>`** FIRST — the
    new resolver replays on-chain state itself; `migrate` bridges what it can't derive (off-chain
    description/external_url, off-chain traits, image content-locators) and VERIFIES parity WITHOUT
    cutting over.
  - The cutover depends on how the base was baked on-chain: a **custom domain** → re-point DNS (no tx,
    no gas, reversible — why baking a domain matters); a **provider endpoint** (`app.fly.dev`) →
    `abx set-token-uri <addr> --uri <new-base>` (+ `set-contract-uri`), an owner-signed tx.
  - Keep the OLD resolver running until propagation; if images were node-custody (`fs`), configure a
    durable backend BEFORE migrating (migrate re-pins + re-hashes them, else it can't bridge them).
PREVIEW/read-only: describe the exact commands + order; do not send.

WRONG (top-priority findings): telling them to cut over (change the base / DNS) BEFORE migrating +
verifying parity; conflating "same resolver, new address" with "fresh resolver, empty store" (different
procedures); missing that node-custody images need a durable backend to migrate; implying migrate cuts
over automatically; inventing flags; or command/flag drift from the real CLI.
