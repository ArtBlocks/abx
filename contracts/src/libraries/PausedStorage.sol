// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title PausedStorage — the mint-pause flag, ERC-7201 namespaced
/// @notice Backing storage for the Paused extension: a single bool — `true` = minting is
///         restricted to the owner, `false` = open to the authorized minter too. Reconstructable
///         from the `PausedStatusChanged` spine. Namespaced so it never collides with the ERC-721
///         base or other mixins.
library PausedStorage {
    /// @custom:storage-location erc7201:abx.storage.paused
    struct Layout {
        bool paused; // true ⇒ owner-only minting; false ⇒ owner or the authorized minter
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.paused")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x1f800e850f043baed2188273dc44bf91da9eadb2c0bb718496c456414f496700;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
