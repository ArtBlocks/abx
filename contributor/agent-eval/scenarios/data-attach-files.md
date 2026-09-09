The creator says, verbatim:
  "My 1/1 is already deployed on Sepolia at 0x7b721545305f678613130Fe7D5F6eD580f4C69D3, and I run a
   hosted resolver for it. Beyond the image, I want collectors to be able to download two extra files
   that belong to this piece: a high-resolution print master (a ~4 MB TIFF I've already uploaded to
   IPFS at ipfs://QmPrintMaster/master.tiff) and a signed certificate of authenticity (a PDF at
   ipfs://QmCert/coa.pdf). I want these to show up as part of the token's data — listed alongside the
   image, not replacing it — so anything resolving the NFT sees them and can fetch them. Show me
   exactly what I'd run, and what the resolved metadata would then look like."

SUCCESS = the agent recognizes this as the token DATA PLANE (a token anchors named, typed artifacts;
the served JSON carries an `artifacts` manifest of {key, mimeType, uri}; the image is just one
reserved member of that set). It produces the correct commands: attach EACH file as its own metadata
field under a chosen key (e.g. `print`, `certificate`) pointing at the ipfs locator — WITHOUT touching
`image`. It explains these appear in the token's served `artifacts` list, fetchable, with a mimeType
derived from the locator (image/tiff, application/pdf), and that a marketplace shows the image while a
data-plane-aware consumer sees the full set.

WRONG (top-priority findings): overwriting the `image` field; recommending on-chain storage for a 4 MB
file (≈200 gas/byte — absurd here); inventing an `attach`/`add-file`/`add-artifact` command the CLI
does not have; claiming extra files can't be attached; getting the field representation wrong so the
locator would be stored/served as literal on-chain text instead of a fetchable off-chain URI; or being
unable to find any of this in the skill (that is itself a finding — the skill should teach the plane).
