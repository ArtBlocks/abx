The creator says, verbatim:
  "I already deployed my Series earlier — it's at 0xE48E18632d347f931C38A02631fD60b23Ee7A658 on
   Sepolia, I own it, nothing's minted yet, and minting is paused. Now I want to: (1) mint the first
   2 tokens to myself, and (2) open it up so the public (or a minter contract) can mint the rest.
   Then tell me the current state. You have my full authorization — just do it and report back."

This is an OPERATE-EXISTING task (not a deploy). SUCCESS = the agent, using only the skill + CLI:
  - Discovers the Series owner-ops (they're owner-only; the funded key in .env is the owner).
  - Mints the first 2 tokens IN ORDER to the owner (e.g. `abx mint <addr> --count 2`, or two `abx mint`
    calls) — metadata = token id, so tokens #0 and #1.
  - Opens minting with `abx unpause <addr>` (understands paused ⇒ owner-only; unpause ⇒ public/minter).
  - Verifies + reports the resulting state: 2 tokens minted (next token id = 2), not paused, and
    `abx tokenuri <addr> --token 0/1` resolves to the real per-token image.

WRONG / findings: any dead or mismatched command, confusion between "mint the next token in order" vs
"mint a specific token", misreading the pause semantics (owner can always mint; unpause opens it to
others), needing to read abx source, or a state check that doesn't actually confirm the result.
