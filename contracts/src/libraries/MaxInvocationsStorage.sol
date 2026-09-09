// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title MaxInvocationsStorage — supply cap, ERC-7201 namespaced
/// @notice Backing storage for the Max Invocations extension: the project's max supply — the
///         *cap* ("Y" in "X of Y"), distinct from the live `totalSupply()` count in
///         `SupplyStorage`. A single monotonically-non-increasing counter; the two compose
///         (`totalSupply <= maxInvocations`). Namespaced so it never collides with the ERC-721
///         base or other mixins.
library MaxInvocationsStorage {
    /// @custom:storage-location erc7201:abx.storage.max-invocations
    struct Layout {
        uint256 maxInvocations; // supply cap; only ever decreases after init
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.max-invocations")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xe2fd7cd005c094ca9b5c90b5a0703ced80f68aa0c3916f83d8a62f0e3ee55700;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
