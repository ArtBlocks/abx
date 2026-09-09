// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title ParamsStorage — Params extension state, ERC-7201 namespaced
/// @notice Backing storage for the Params extension: `key → (bytes32 value, valueIsHash, isSet)`
///         at token and contract scopes, plus one SSTORE2 data pointer per large value. `isSet`
///         is explicit so an indexer (and the contract) can distinguish "param is 0" from
///         "param unset" — clearing is a distinct act (`…ParamCleared`), never a zero write.
///         A large value is **one blob, never multi-chunk** (bounded by the ~24 KB SSTORE2
///         ceiling — one bound, one read); `value` then carries the keccak256 of the content
///         (`valueIsHash = true`). Content above the ceiling is a *pointer* param (IPFS/Arweave
///         locator), not a bigger param. Reconstructable from the `…ParamConfigured` /
///         `…ParamCleared` spine (+ the data read at head). Namespaced so it never collides
///         with the ERC-721 base or other mixins.
/// @notice The store is **enumerable**: each scope carries a key list beside its map, so an
///         on-chain consumer (the generator, the renderer) reads a token's whole param set in
///         one `eth_call` instead of guessing keys. Invariant: `key ∈ list ⟺ params[key].isSet`,
///         with one exception — the reserved `seed` key is never indexed (every consumer reads
///         it directly as a tokenData coordinate, so indexing it would charge each seeded mint
///         for nothing). Enumeration order is insertion order and is not part of the contract:
///         canonical serialization sorts.
/// @dev The lists are **derived state**, maintained by {AbxParamsLib} at the write choke points
///      (`index == 0` is the membership test — never `isSet`, so the index stays self-contained;
///      removal is swap-and-pop). They emit nothing of their own: the `…ParamConfigured` /
///      `…ParamCleared` spine already reconstructs the key set off-chain, so reconstruction is
///      unchanged.
library ParamsStorage {
    /// @notice One param's active state: the value (or its hash) + how to read it.
    struct Param {
        bytes32 value; // the literal (valueIsHash = false) or keccak256 of the full value (true)
        bool valueIsHash; // how to read `value`; full content reads back via the data view
        bool isSet; // explicit — a zero value is a valid value, distinct from unset
    }

    /// @custom:storage-location erc7201:abx.storage.params
    struct Layout {
        mapping(uint256 tokenId => mapping(bytes32 key => Param)) tokenParams;
        mapping(bytes32 key => Param) contractParams;
        mapping(uint256 tokenId => mapping(bytes32 key => address)) tokenData; // SSTORE2 pointer
        mapping(bytes32 key => address) contractData; // SSTORE2 pointer
        mapping(uint256 tokenId => bytes32[]) tokenParamKeyList; // insertion order; `seed` excluded
        // 1-based position in the list above; 0 = absent, and that is the membership test
        mapping(uint256 tokenId => mapping(bytes32 key => uint256)) tokenParamKeyIndex;
        bytes32[] contractParamKeyList; // insertion order; `seed` excluded
        mapping(bytes32 key => uint256) contractParamKeyIndex; // 1-based; 0 = absent
        // True once ANY token in this collection has been assigned a `seed`. One bit, and it is
        // what makes the seed's governance model a pre-sale commitment: after the first seeded
        // mint, `setParamSchema` refuses the `seed` key, so whether a seed is reassignable — and by
        // whom — is fixed and readable (`paramSchema("seed")`) before anyone buys. Without it, an
        // creator could declare a `seed` schema *after* selling out and reassign work a collector
        // had already paid for, which is a silent change of terms rather than a disclosed feature.
        bool anySeedAssigned;
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.params")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xf5e6009a1f3253941c000e981d598a08090cf5d0f2e19d5e2531598d12885300;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
