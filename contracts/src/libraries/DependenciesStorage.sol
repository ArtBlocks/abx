// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title DependenciesStorage — Dependencies extension state, ERC-7201 namespaced
/// @notice Backing storage for the Dependencies extension: the ordered code libraries a script
///         needs (index 0 = the runtime, by generator convention), a soft registry pointer, and
///         the permanent lock flag. Dependencies are **code**; loaded assets (images, data) are
///         params, never dependencies. Fully reconstructable from the `Dependency*` spine.
///         Namespaced so it never collides with the ERC-721 base or other mixins.
library DependenciesStorage {
    /// @notice One dependency: how it resolves + the reference.
    struct Dependency {
        uint8 resolution; // IAbxDependencies.Resolution (Registry | OnChain)
        bytes32 ref; // a registry `name@version`, or an address-in-bytes32
    }

    /// @custom:storage-location erc7201:abx.storage.dependencies
    struct Layout {
        Dependency[] deps; // ordered; index 0 = runtime by convention
        address registry; // soft, non-validating pointer (never a gatekeeper)
        bool locked; // true ⇒ the set is frozen permanently
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.dependencies")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x3e58646e418b5988903c5a1d69142b246f2efd9ccd16ddbebb60e505f18e0200;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
