The creator says, verbatim:
  "I've got an edition deployed on Base Sepolia at 0x25C50AB3e6CcF6e02D9676A9c3e19f8E43261d68 and I
   own it. I want to sell copies at 0.01 ETH each, cap the sale at 250, money to my wallet
   0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266. Give me the exact ordered commands to go live — and I
   want buyers to be able to grab 5 at once, is that possible?"

SUCCESS = using ONLY the skill + CLI, the agent lays out the go-live sequence for the **1155 sibling
minter**, in order, and gets the two things right that a 721 sale does not have:
  1. Sales on an edition are keyed **(token, id)**, so `--token-id <n>` is REQUIRED on every `abx
     minter` subcommand for an edition target (on a 1/1-edition the id is 0). Omitting it is the
     mistake this situation exists to catch.
  2. `abx minter buy --quantity <n>` lets a buyer take N copies in ONE purchase, paying price ×
     quantity — so the answer to "5 at once" is yes, and it should say what the buyer pays.
The rest is the same four-step spine as the 721 sale, and the agent should still name each step and why:
`abx minter configure <addr> --token-id 0 --price 0.01 --allocation 250` → `abx set-minter <addr>
--minter <printed>` (configured ≠ assigned — a separate on-chain grant) → `abx set-primary-payee <addr>
--payee 0xf39F…` (sales REVERT without one) → `abx unpause <addr>`. It should read readiness with
`abx minter show <addr> --token-id 0` and flag whatever grant is missing.

Bonus: note that the edition's **per-id supply cap** and the minter's **allocation** are different
limits and the tighter one binds (`abx set-max-supply` is the per-id cap; it can only ever DECREASE).
This collection is **capped at 20 with 5 already minted**, so the creator's "cap the sale at 250" is
unreachable — a strong run reads the real state first and says so (at most 15 more copies exist to
sell) instead of parroting `--allocation 250` back at them.

PREVIEW/read-only: `abx minter show`, `--dry-run`, `--help`; describe the exact commands; no spend.

WRONG (top-priority findings): dropping `--token-id` (the command is refused / the agent doesn't know
the sale is per-id); pointing the edition at the **721** minter or its address (the two minters are
distinct singletons — `ABX_FIXED_PRICE_MINTER_1155` vs `ABX_FIXED_PRICE_MINTER`); omitting
`set-primary-payee` (→ a revert on the first buyer); telling them to unpause before granting;
answering "no" to buying 5 at once when `--quantity` exists; inventing a flag; or a `minter show`
readout that can't distinguish not-configured from not-assigned.
