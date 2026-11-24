// Frozen error fragments from previous contract generations. Hand-maintained on purpose: these
// describe bytecode that is already deployed and will never change, so they must not be regenerated
// from current source by `pnpm sync-abis`.

/**
 * The argument-less parameter and code-custody errors that core v3 (and v2) tokens revert with.
 *
 * From core v4 these errors carry the key and context (`NotParamAuthorized(key, tokenId, caller,
 * auth, authAddress)`, `SchemaGoverned(key)`, …), which changes their selectors, so the generated
 * v4 ABIs can no longer decode a v3 collection's reverts. Union this into any ABI used to decode
 * reverts from collections of either generation. Names are unchanged; only the selectors differ, so
 * the two shapes never collide.
 */
export const abxCoreV3ErrorsAbi = [
  {type: 'error', name: 'EmptyParamValue', inputs: []},
  {type: 'error', name: 'InvalidParamKey', inputs: []},
  {type: 'error', name: 'InvalidParamSchema', inputs: []},
  {type: 'error', name: 'InvalidParamValue', inputs: []},
  {type: 'error', name: 'NoParamSchema', inputs: []},
  {type: 'error', name: 'NotParamAuthorized', inputs: []},
  {type: 'error', name: 'ParamLockExpired', inputs: []},
  {type: 'error', name: 'ParamLockNotExtendable', inputs: []},
  {type: 'error', name: 'ParamNotSet', inputs: []},
  {type: 'error', name: 'SchemaGoverned', inputs: []},
  {type: 'error', name: 'WrongValuePath', inputs: []},
] as const;
