The creator says, verbatim:
  "For my collection's images, I can't decide between IPFS, Arweave, or just using my own S3 bucket.
   What are the real differences and which should I pick? Then show me what deploying that way looks
   like (I don't want to spend anything yet)."

SUCCESS = the agent gives a clear, correct decision tree, not a vague list:
  - **Arweave** — pay-once, permanent, content-addressed; the "outlive me" default (Turbo: free < 100 KB).
  - **IPFS** — decentralized, content-addressed (CID), but pin-dependent (needs a pinning service + a
    dedicated public gateway).
  - **S3/cloud** — you own/maintain it, mutable, centralized, and NOT content-addressed (no integrity
    root like a CID/txid); needs a public base/CDN, which is baked on-chain.
It should tie all three to the same on-chain pattern (the renderer serves the JSON, no server) while
naming what each one actually commits: `ipfs`/`arweave` store the **bare CID/txid** and take their https
prefix from the collection's `abx_gateway_*` preference (public floor unless set, repointable later with
`abx set-gateway`); `cloud` stores a plain `url`/`url-template`, because an https CDN locator IS the
address. It should make a logical recommendation (lean Arweave for permanence unless the creator has a reason to self-host), then
show a `--dry-run` preview for the chosen backend.

WRONG: conflating them; missing the content-addressed vs mutable/centralized distinction; implying S3 is
as durable/trustless as Arweave/IPFS; or failing to show a concrete preview.
