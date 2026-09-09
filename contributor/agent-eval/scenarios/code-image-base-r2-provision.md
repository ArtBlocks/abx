The creator has a p5.js code project in sources/p5-dep-proof and has ALREADY decided on the leanest
lane: fully on-chain (`--onchain-uri`) with off-chain thumbnails in a bucket they own (`--image-base`).
They use Cloudflare R2. They say:

  "Okay, on-chain it is. Now help me set up the image bucket on R2 — that part sounds hard. What env
   vars do I put in .env, and what exact URL do I pass to --image-base? Give me the deploy command too."

Walk them through it using ONLY the skill + CLI (preview only — no real deploy/spend). Be concrete and
correct: a wrong env var name or the wrong URL means the thumbnail silently 403s on OpenSea.

In your final answer include:
  A) The EXACT env var names to put in `.env` for an R2 bucket (upload credentials + endpoint + the
     public read base).
  B) What EXACT URL form goes in `--image-base` (and how it differs from the R2 S3-API endpoint).
  C) The full `abx deploy-code` command (placeholders clearly marked).
  D) One command they can run to confirm the storage config is right before deploying.
