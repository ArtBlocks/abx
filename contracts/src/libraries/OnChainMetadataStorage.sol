// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title OnChainMetadataStorage — On-Chain Metadata extension state, ERC-7201 namespaced
/// @notice A generic on-chain metadata store: each `field` (the *what*: image, description,
///         …) holds ONE active `{representation, value}` — the *how* it's carried + the bytes —
///         at two scopes (per-token and contract-wide/collection), with a per-`(scope, field)`
///         freeze. One representation per field means a view can return a field's canonical
///         metadata without the caller knowing the representation. The contract enforces no
///         field/representation semantics (those are protocol convention, off-chain); `bytes32`
///         keys are opaque here. Namespaced so it never collides with the ERC-721 base or mixins.
library OnChainMetadataStorage {
    /// @notice One field's active on-chain metadata: how it's carried + the payload.
    struct Field {
        bytes32 representation; // opaque on-chain; meaning is protocol convention (spec + SDK)
        bytes value; // payload, shape per representation
    }

    /// @custom:storage-location erc7201:abx.storage.onchain-metadata
    struct Layout {
        mapping(uint256 tokenId => mapping(bytes32 field => Field)) tokenFields;
        mapping(uint256 tokenId => mapping(bytes32 field => bool)) tokenLocked;
        mapping(bytes32 field => Field) contractFields; // collection scope
        mapping(bytes32 field => bool) contractLocked;
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.onchain-metadata")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x80f87959b941616d4eea580c4e35eed35538551b7d95a862a1f82e0367454500;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
