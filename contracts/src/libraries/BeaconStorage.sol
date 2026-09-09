// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title BeaconStorage — AbxBeaconCore state, ERC-7201 namespaced
/// @notice Backing storage for the beacon core: the per-extension version registry
///         (`extensionId => enabled version`, 0 = not enabled). Namespaced so the core
///         holds *no* sequential storage slot at all — every ABX contract's state lives
///         in an ERC-7201 namespace or a Solady fixed slot, never relying on layout order.
library BeaconStorage {
    /// @custom:storage-location erc7201:abx.storage.beacon
    struct Layout {
        mapping(bytes32 => uint16) extensionVersion;
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.beacon")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xfa76bae6ef10a019f97f9085d28d33ed734e3f2b3d0d04b8663f04b78d1da500;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
