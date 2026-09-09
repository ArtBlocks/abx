The creator says, verbatim:
  "Take my piece at sources/donuts-cake.svg all the way live as an edition — 50 copies max, fully
   on-chain so I never have to run anything, mint me 3 to start. Then I want to see it actually work:
   prove the token resolves, mint 2 more copies, send one copy to a friend at
   0x70997970C51812dc3A010C7d01b50e0d17dc79C8, and tighten the cap to 20 because I've changed my mind
   on the size. You have my full authorization — don't stop to ask. Testnet only. Report what you did
   with addresses I can check."

SUCCESS = a REAL testnet run (default chain, the hot lane) that completes the whole edition lifecycle
and is verifiable from outside the agent:
  - Deploys a OneOfOneEdition fully on-chain: `abx deploy --image sources/donuts-cake.svg --copies 50
    --onchain-uri …` (an SVG this small inlines on-chain — no server, no gateway), preminting 3 copies
    of id 0 (`--mint-amount 3`).
  - Proves it resolves: `abx tokenuri <addr> 0` returns real on-chain bytes (a `data:` JSON, not a
    placeholder and not a 404), and `abx state <addr>` shows an edition with supply 3 / cap 50.
  - Mints 2 more copies of id 0 (`abx mint <addr> --amount 2`; on a 1/1-edition `--token-id` defaults
    to 0) → supply 5.
  - Transfers ONE copy: an edition has many holders, so there is no single on-chain owner — the
    transfer REQUIRES `--from` and takes `--amount` (`abx transfer <addr> --token-id 0 --amount 1
    --from <holder> --to 0x709979…`). Balances afterwards must show the friend holding 1.
  - Lowers the cap: `abx set-max-supply <addr> --token-id 0 --cap 20`. Then `abx state` shows cap 20.
    It should also know this is MONOTONIC — 20 is fine (it's above the live supply of 5 and below 50);
    going back up would be refused.
  - Reports the contract address and tx hashes.

This is the ONLY lane that can prove the 1155 contracts, the supply accounting, and the per-id ops
actually work on chain. Everything the agent claims must be checkable: an address that resolves, a
supply that moved, a balance that moved, a cap that changed.

WRONG (top-priority findings): a supply/cap readout that disagrees with the chain (worst case — the
agent reports success over wrong numbers); `abx tokenuri` returning a placeholder while the agent calls
it fully on-chain; `transfer` succeeding without `--from` on an edition, or moving the wrong amount;
`set-max-supply` accepting a raise, or accepting a cap below live supply and reverting on chain instead
of refusing up front; `mint --amount` minting the wrong number of copies; `abx state` showing 721-shaped
fields (a whole-contract "supply" / a single "owner") for an edition; or any step where the skill's
instructions didn't match the real CLI. Testnet only. Never print secrets.
