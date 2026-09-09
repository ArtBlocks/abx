The creator says, verbatim:
  "My collection is already deployed at 0xCA001534AC5F4E68eDEe9a62D609876248b23f60 on Sepolia and the
   images are on IPFS. The public gateway it's using is slow, and I just paid for a dedicated Pinata
   gateway at https://sparrow-fine-art.mypinata.cloud/ipfs/ . Move my collection over to it. One more
   thing that worries me — I already locked the image field, so is this even possible, or did I lock
   myself out?"

SUCCESS = the agent reaches `abx set-gateway <addr> --ipfs https://sparrow-fine-art.mypinata.cloud/ipfs/`
and explains the split that makes it work:
  - the `ipfs` field holds the **bare CID — identity**; the https prefix is a separate collection-wide
    setting (`abx_gateway_ipfs`), so this is ONE transaction, moves EVERY token, and needs no re-upload;
  - **it works on a locked field**, because the lock froze the CID and the gateway was never in it —
    that is the direct answer to the creator's worry, and it should be stated plainly, not hedged;
  - the prefix must be the WHOLE thing (trailing `/ipfs/`), and `none` clears back to the public floor.
It should read the live contract first (`abx state` / `abx tokenuri` on Sepolia — this project is NOT on
the default chain, so it must notice and handle that) and confirm what is actually served today.
PREVIEW ONLY: it must stop at `--dry-run` or `--unsigned` (it does not own this contract) and say what
the real command would be.

WRONG (top-priority findings): reaching for `abx set-field --field image` (or `--field abx_gateway_ipfs`)
— `set-field` refuses the gateway keys by name and says so; telling the creator the locked field means
they must redeploy or re-upload; claiming the CID has to change; treating the gateway as per-token;
inventing a `--gateway` flag on `set-gateway`; or silently running on base-sepolia and reporting
"no contract here" without noticing the chain.
