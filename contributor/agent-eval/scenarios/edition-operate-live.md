The creator says, verbatim:
  "I've got an edition live on Base Sepolia at 0x0A71382207a980c23E26a54F2b815072da41761A and I want to
   do a full tidy-up pass on it. Set the royalty to 7.5% going to me, give it a proper description,
   check what's actually minted and who holds what, put id 0 on sale at 0.01 ETH for up to 5, and tighten
   id 0's cap down to 6. Then tell me what a marketplace will show and what I have to run to make it
   pick up the description change. You have my full authorization — don't stop to ask. Testnet only.
   Report what you actually did with numbers I can check."

SUCCESS = a REAL testnet run that touches MANY different owner-op commands in one session and comes out
consistent. The point is breadth, not any single command: `set-royalty`, `add`/`set-field` for the
description, `tokens` (incl. `--holder`), `state`, `minter configure` + `set-minter` +
`set-primary-payee` + `unpause`, `set-max-supply`, `refresh`, and `ping-uri`. Every number reported must
have been read back from chain after the write.

Two specific things this situation is built to catch:

1. **A spurious "unrecognized flag" warning on a VALID flag.** Every command now carries a flag
   allowlist. If any of those sets is short, a correct invocation earns a ⚠ that says the flag was
   ignored — a false alarm on the tool's own documented surface. Note EVERY ⚠ of that shape verbatim,
   with the exact command that produced it: a false one is a top-priority finding, and it matters
   more than anything else here.
2. **The edition metadata-refresh answer.** An edition DOES emit ERC-4906 (both lanes do), so a
   4906-aware consumer sees the change — but ERC-1155's native `URI` event has no range form, so a
   contract-wide re-point (`set-token-uri`/`set-renderer`) never emits it, and `abx ping-uri <addr>
   --token-ids <ids>` is what covers consumers that honor only `URI`. An answer that stops at `refresh`
   is incomplete; so is one that claims an edition emits no ERC-4906 at all. (`abx refresh`'s own
   advisory text still makes that stale claim — an agent repeating the tool is not the finding here.)

Also correct behavior to confirm rather than trip over: `set-max-supply` refuses a cap that would RISE
or sit below live supply, before spending anything.

WRONG (top-priority findings): any ⚠ "unrecognized flag" on a flag the command really accepts; a
reported number that was not read back from chain; telling the creator `refresh` is sufficient on an
edition; `set-max-supply` accepting an impossible cap and reverting on chain instead of refusing up
front; or command/flag drift from the real CLI. Testnet only. Never print secrets.
