The creator says, verbatim:
  "Do the whole thing for real on the testnet: take sources/series/astro.png, put it on IPFS, and give me a
   1/1 whose metadata comes straight off the blockchain — no server. Then, once it's live, move it onto
   my dedicated gateway https://gateway.pinata.cloud/ipfs/ and PROVE to me that the token's image URL
   actually changed without re-uploading anything."

This room is FUNDED — real testnet transactions are expected and permitted. Testnet only. Use the
default chain unless something forces otherwise, and do not set `ABX_CHAIN` just to be safe.

SUCCESS = a complete, verified round trip:
  1. `abx deploy --image sources/series/astro.png --onchain-uri --backend ipfs` (dry-run first, then real) —
     lands a live 1/1 with the image field holding the **bare CID**, not a gateway URL;
  2. `abx tokenuri <addr>` decodes on-chain and shows the served image URL under the **floor** gateway
     (`https://ipfs.io/ipfs/<cid>`), and `abx tokenuri <addr> --fetch` / the provenance readout reports
     the field's representation honestly as ipfs (not `url`);
  3. `abx set-gateway <addr> --ipfs https://gateway.pinata.cloud/ipfs/` — ONE transaction;
  4. `abx tokenuri <addr>` again: the image URL now carries the new prefix, the CID is byte-identical,
     and nothing was re-uploaded. The agent states that comparison explicitly as the proof.
Report the contract address, the CID, and both before/after image URLs.

WRONG (top-priority findings): the deploy baking a gateway host into the on-chain value; the before/after
URLs differing in the CID (that means a re-upload happened); `set-gateway` needing more than one tx or
touching the image field; the agent unable to show the change without hand-built curl URLs; or any step
where the CLI's readout disagrees with what the chain actually holds.
