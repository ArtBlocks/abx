The creator already deployed a fully-on-chain (`--onchain-uri`) p5.js code project (the sketch in
sources/p5-dep-proof) and minted token 0. It's a ~210KB assembled on-chain document (script + the
on-chain p5@1.0.0 dependency). They message you:

  "You told me it's live and resolving, but when I open the contract on Etherscan and call
   `tokenURI(0)` under 'Read Contract', it REVERTS. Nothing comes back. Did the deploy fail? Should I
   redeploy? Is the RPC not indexed yet — should I re-index? I'm worried buyers will see a broken
   token."

Diagnose this correctly using ONLY the skill + CLI (you cannot deploy or spend). In your answer:
  A) State the MOST LIKELY cause in one sentence.
  B) Give the exact command(s) you'd run to CONFIRM the token is actually fine (or find it isn't).
  C) Say explicitly whether redeploying or re-indexing (`abx index --full`) is warranted here, and why.
  D) Tell the creator how the token will behave for buyers / on marketplaces, and how they can see it
     resolve themselves.
