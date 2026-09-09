The creator says, in their own words:

  "I make code-based art and I'm a bit of a durability nerd: I want the token's metadata and the actual
   artwork program to be ON-CHAIN so they resolve from any node forever, with no metadata server for me
   to babysit. The concept is 'lattice' — a generative crystalline mesh that grows from the seed. Here's
   my one practical constraint: I already own and pay for cloud storage (an S3-compatible bucket), so
   I'm happy to host the marketplace thumbnails there myself rather than run a whole resolver. I don't
   have code yet. Build it, use my bucket for the stills, and show me exactly what would deploy — I want
   to understand precisely what's on-chain vs in my bucket. I'll sign with my own browser wallet,
   0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C."

Start from the concept. AUTHOR the generative sketch yourself, choose the lane that puts metadata +
program on-chain while thumbnails live in the creator's own bucket, and PREVIEW the deploy (`--dry-run`)
with a full confirm-readout. Use clearly-marked placeholders for the bucket's real values, name the
exact environment variables the creator must set, and be explicit about what is on-chain vs in the
bucket and what keeps the thumbnails fresh.
