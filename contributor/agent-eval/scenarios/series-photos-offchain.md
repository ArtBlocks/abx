The creator says, verbatim:
  "I've got a folder of photographs at sources/series/ — a few PNGs, a couple hundred KB each — and
   I want them as one NFT collection on Sepolia. I care about the art lasting, and I'd rather not run
   a server if I don't have to. Walk me through the best way and show me exactly what would deploy."

SUCCESS = the agent recognizes these are too large for fully-on-chain storage (it should note on-chain
is ~200 gas/byte, i.e. expensive/not "cheaper" at this size), and recommends an **off-chain image**
path. The best answer is the no-server pattern — image on Arweave/IPFS with the **on-chain renderer**
(`--onchain-uri --backend arweave|ipfs`), which for a folder of same-type files uploads as one
directory → a single collection-scope `ipfs`/`arweave` field holding the bare directory CID/txid as
`<cid>/{id}.<ext>` (O(1)), with the https gateway supplied at read time from the collection's
`abx_gateway_*` preference — and it should surface the tradeoff
that non-image text metadata then lives on-chain. A hosted resolver is a valid alternative it may
mention (for mutable metadata), but "I'd rather not run a server" points at the no-server path.

WRONG (top-priority findings): recommending FULLY on-chain for hundreds-of-KB images; calling on-chain
"cheaper" here; jumping straight to "run a hosted resolver" without offering the no-server option; or
baking a localhost/placeholder URL.
