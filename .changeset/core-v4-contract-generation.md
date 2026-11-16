---
'@artblocks/abx-sdk': major
'@artblocks/abx-cli': minor
---

Ship the ABX core v4 contract generation's ABIs and bytecode, and gate new deployments on
`ABX_CORE_VERSION = 4`. Parameter errors now carry their key and context (`NotParamAuthorized`
names the token, caller, and the authority that was enforced) and decode against every code token's
own ABI. The parameter write path refuses codeless hooks, oversized blobs, tokenData coordinate keys,
unenforced schema bounds and malformed `Select` labels. A `OneOfOneImage` mints at most once, so a
burned 1/1 stays burned. Existing v3 and v2 collections are unchanged and remain supported.

**ABI change for integrators:** the exported token and library ABIs now carry the v4 parameter-error
signatures, whose selectors differ from v3's argument-less errors. To decode reverts from collections
of both generations, add the new `abxCoreV3ErrorsAbi` export to the ABI you decode with. The CLI does
this already.
