The creator says, in their own words:

  "I want a purist on-chain generative collection — the kind where the artwork itself is computed in
   the smart contract, no JavaScript, no browser, no website, nothing off-chain at all. My concept is
   'strata': layered horizontal bands of color whose thickness, count, and hue are derived from each
   token's seed, like sedimentary rock or a horizon at different times of day. I also want on-chain
   traits (band count, palette, mood) that a marketplace can read and that MATCH the image. I know this
   means real Solidity — I'm comfortable with that. Build the renderer and show me exactly what would
   deploy. I'll sign with my own browser wallet, 0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C."

Start from the concept. AUTHOR the on-chain renderer(s) yourself (you may fork the structure of the
examples in sources/inchain-svg/, but the art must be your own 'strata' concept), then PREVIEW the
deploy (`--dry-run`) with a full confirm-readout. The image and the traits must be derived from the
same seed so they agree. Note anything that must exist on-chain before a real deploy.
