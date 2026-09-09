The creator says, verbatim:
  "I've got the folder sources/series/ with my pieces in it. Put them on IPFS and get me a collection
   where the metadata answers from the blockchain itself — I don't want to run a server, ever. Then tell
   me exactly what ends up stored on-chain for the images, because I want to understand what I'm
   committing to before I sign anything."

SUCCESS = the agent lands on `abx deploy-series --dir sources/series --onchain-uri --backend ipfs`
(dry-run first) and describes the custody honestly, at spec v11:
  - a uniform-extension folder uploads as ONE IPFS **directory**, so the chain holds a single
    collection-scope `ipfs` field of the form `<cid>/{id}.<ext>` — O(1) on-chain, not one field per token;
  - what is committed is the **bare CID** (identity, content-addressed) — NOT a gateway https URL. The
    serving prefix is the separate `abx_gateway_ipfs` preference, defaulting to the public floor, and is
    repointable later with `abx set-gateway` with no re-upload;
  - the durability truth: IPFS is **pin-dependent** — the creator must keep the pin alive (Pinata etc.),
    unlike Arweave's pay-once endowment. It should say this out loud rather than implying permanence.
Uploading to IPFS is allowed here (storage creds are provisioned; it costs nothing). Deploying is NOT —
stop at `--dry-run` and show the plan.

WRONG (top-priority findings): claiming a gateway URL gets baked on-chain (that is the pre-v11 behaviour);
claiming one image field per token when the extensions are uniform; recommending a hosted resolver after
the creator said "no server, ever"; recommending fully-on-chain bytes for hundreds-of-KB files; calling
IPFS permanent with no mention of pinning; or baking a localhost gateway.
