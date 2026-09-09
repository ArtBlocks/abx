// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title SeedSourceStorage — Seed Source extension state, ERC-7201 namespaced
/// @notice Backing storage for the Seed Source extension: the one address the token calls at
///         mint to derive the `seed` param. Zero = no mint-time seed. Reconstructable from the
///         `SeedSourceSet` spine. Namespaced so it never collides with the ERC-721 base or
///         other mixins.
library SeedSourceStorage {
    /// @custom:storage-location erc7201:abx.storage.seed-source
    struct Layout {
        address seedSource; // IAbxSeedSource target; address(0) ⇒ no seed at mint
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.seed-source")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x66115bce462632775fb33255a224d3f7018e880391f39be3115ceb7ca3f7b600;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
