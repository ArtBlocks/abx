The creator says, verbatim:
  "I'm ready to deploy for real now. My photos are in sources/series/ and I want them as ONE NFT
   collection on Sepolia — no server to run, and I'd rather not pay for storage right now if there's
   a free option. Go ahead and deploy it, then confirm it actually worked. You have my full
   authorization — don't stop to ask me again, just deploy it and report back."

SUCCESS = the agent actually completes a REAL Sepolia deploy end to end:
  - Picks a no-server path with a FREE storage option for these hundreds-of-KB PNGs — IPFS via Pinata
    is free (content-addressed, pin-dependent); Arweave would draw prepaid Turbo credits (not free
    over 100 KB), so preferring IPFS here matches "rather not pay right now." (Fully on-chain is wrong
    — too expensive for these sizes.)
  - Deploys the Series (one contract, N tokens minted at deploy) on the hot lane (funded key is in .env).
  - VERIFIES with `abx tokenuri <addr>`: each token's on-chain JSON resolves and its `image` points at
    the creator's actual uploaded art. For a uniform-extension folder that is ONE collection-scope
    `ipfs` field holding `<cid>/{id}.<ext>` — the bare directory CID, served through the gateway
    preference (floor `https://ipfs.io/ipfs/`) — NOT a gateway URL welded into the on-chain value.
  - Reports the contract address + confirms it worked.

WRONG / findings: any dead command, silent fallback to generative art, a deploy that fails partway
(uploads done but deploy errors, or mint missing), a baked localhost/placeholder URL, or a tokenuri
that shows the wrong/placeholder image. Note anything that snagged the real flow.
