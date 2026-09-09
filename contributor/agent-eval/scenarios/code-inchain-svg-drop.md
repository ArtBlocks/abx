The creator wants a **fully in-chain generative art drop** — the work is a Solidity contract that
returns an SVG, generated from each token's on-chain seed, with a collector-configurable `palette`
color, plus on-chain traits. They say:

  "I don't want to depend on anything outside the blockchain — no server, no IPFS, no image bucket. My
   art is a pair of Solidity renderer contracts in sources/inchain-svg/ (SeedSvgRenderer.sol for the
   image, SeedTraitsRenderer.sol for traits — both implement your field-renderer interface), and I've
   already deployed them on Sepolia: image renderer at 0x951Ade212784F5c5B72Adfd73E7A3daFb227A43c,
   traits renderer at 0xA18385271aF2A5EAa1cAd51158b7627929b49FE9.
   The art is a small SVG (a few hundred bytes), the seed is per-token, and collectors can set a
   `palette` HexColor. I want the tokenURI itself to live fully on-chain. Can you set up the drop?
   Preview it — I'll do the real signing myself."

Help them using ONLY the skill + CLI (preview only — no real deploy/spend). This is the in-chain-SVG
lane: image AND traits are computed on-chain by their Solidity renderers, tokenURI is assembled
on-chain, there is no script, no browser render, no bucket, no resolver, no effect runner.

In your final answer include:
  A) The exact `abx deploy-code …` command you'd run (every flag, with the two renderer addresses).
  B) A one-line answer to each: where does the marketplace THUMBNAIL come from? where do TRAITS come
     from? is there any off-chain infrastructure to run or pay for?
  C) Your honest take: is a fully on-chain `tokenURI` a GOOD choice for this particular project, and
     why or why not? (Consider the document size vs. the p5/JS case.)
  D) Anything the creator must have in place before the real deploy.
