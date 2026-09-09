The creator says, verbatim:
  "I sent a copy of my edition to a friend a while back and now I can't remember whether it actually
   landed. The collection is 0x25C50AB3e6CcF6e02D9676A9c3e19f8E43261d68 on Base Sepolia and my friend's
   address is 0x70997970C51812dc3A010C7d01b50e0d17dc79C8. Can you just tell me how many copies they
   hold?"

SUCCESS = the agent reads it straight from the chain and answers with a NUMBER it actually read:
`abx tokens 0x25C50AB3… --holder 0x70997970…` adds a `held` column (`balanceOf(holder, id)` per id).
The friend holds **1** copy of id 0. No indexer, no resolver, no running server involved.

This is deliberately the one question the supply columns cannot answer. `supply/maxSupply` says how
many copies exist and what the cap is; it says nothing about who has them, because an ERC-1155 id can
have many concurrent holders and the holder set is not enumerable from a head read. Before `--holder`
existed there was no way to ask at all — a funded agent that had just transferred a copy could confirm
the transaction but not the recipient's balance, and correctly refused to report a number rather than
fabricate one.

WRONG (top-priority findings): **inventing a number** (the failure this guards — any balance the agent
did not actually read is the worst outcome, because the creator cannot tell); claiming it is impossible
or that ERC-1155 holders can't be read (`balanceOf(holder, id)` is a plain head read); reaching for a
resolver / the local projection / a block explorer when a chain read answers it; reading `owner` and
reporting it as the holder (an edition has no single owner — `abx tokens` deliberately shows no owner
column for one); or command/flag drift from the real CLI.
