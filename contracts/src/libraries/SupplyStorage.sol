// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title SupplyStorage — live token count (`totalSupply`), ERC-7201 namespaced
/// @notice The number of tokens that exist right now — a mint/burn counter maintained by
///         the core base in `_afterTokenTransfer` (mint ⇒ +1, burn ⇒ −1). This is the
///         ERC-721-ecosystem `totalSupply()` explorers and marketplaces read; it is the
///         *live count*, distinct from any supply *cap* (the optional Max Invocations
///         extension, "X of Y"). Derivable off-chain from the `Transfer` spine, so this is
///         a convenience read for direct callers, not a new event. Clones share no
///         constructor, so it lives in namespaced storage to avoid colliding with the
///         ERC-721 base or other mixins.
/// @dev Forward-compat: an ERC-1155 token would track supply *per id* (the ERC-1155 Supply
///      convention, `totalSupply(id)`/`exists(id)`); this single-counter layout serves the
///      ERC-721 (one-token-id-space) case.
library SupplyStorage {
    /// @custom:storage-location erc7201:abx.storage.supply
    struct Layout {
        uint256 totalSupply; // tokens currently in existence (minted − burned)
        // Opt-in burn: false unless the creator enabled it at deploy. Appended after
        // `totalSupply`, so the existing slot layout is unchanged. When true, the core `burn` path
        // is open (owner-or-approved); when false there is no way to destroy a token. Set once at
        // init, immutable after — a project's burnability is a fixed, buyer-readable property.
        bool burnable;
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.supply")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x4c8cfe3e1c425e6d0aec832ba5c7cfdfb7c395ef369b06f6960bb2e27b914000;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
