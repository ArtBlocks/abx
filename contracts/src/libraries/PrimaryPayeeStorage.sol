// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title PrimaryPayeeStorage — primary-sale payout address, ERC-7201 namespaced
/// @notice Backing storage for the Primary Payee extension: a single primary-sale destination
///         (`address(0)` = none). The current value reconstructs from the `PrimaryPayeeChanged`
///         spine. Namespaced so it never collides with the ERC-721 base or other mixins.
library PrimaryPayeeStorage {
    /// @custom:storage-location erc7201:abx.storage.primary-payee
    struct Layout {
        address primaryPayee; // primary-sale payout destination; address(0) = none
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.primary-payee")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xb12267785371ecd1fa011470e352d971eef8208fa0d993253018291e32cbb100;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
