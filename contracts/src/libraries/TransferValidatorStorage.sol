// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title TransferValidatorStorage — creator-token enrollment + validator, ERC-7201 namespaced
/// @notice Backing storage for the CreatorToken extension: the transfer validator address plus
///         the permanent enrollment flag, packed into one slot. Two flags because "enrolled with
///         the validator temporarily zero (enforcement suspended)" is distinct from "never a
///         creator token". Reconstructable from the `TransferValidatorUpdated` spine (plus the
///         extension's beacon version for enrollment). Namespaced so it never collides with the
///         ERC-721 base or other mixins.
library TransferValidatorStorage {
    /// @custom:storage-location erc7201:abx.storage.transfer-validator
    struct Layout {
        address validator; // the active validator; address(0) = unenrolled or suspended
        bool enrolled; // permanent: set once at initialize, never cleared
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.transfer-validator")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x9951623149c334823208d56adab511a5cc14044382fa5f53cd33b5848a276d00;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
