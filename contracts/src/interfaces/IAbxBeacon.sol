// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxBeacon — ABX discovery & versioning (Register 2, core)
/// @notice The only *required* ABX surface. `AbxDeployed` is the chain-wide
///         discovery beacon (platforms watch this topic; no factory enumeration
///         needed). `AbxExtensionVersionSet` pins each enabled extension's version,
///         so no other event carries a version field.
/// @dev The beacon is *spoofable* — any contract can emit it. It serves open,
///      permissionless discovery, not trust. For trust, a consumer verifies the
///      address is a canonical-factory clone (see OneOfOneImageFactory).
interface IAbxBeacon {
    /// @notice Emitted once, at deploy/initialize. `abxVersion` = the core spec version.
    event AbxDeployed(uint16 abxVersion);

    /// @notice Emitted when a contract enables an extension or bumps its version.
    event AbxExtensionVersionSet(bytes32 indexed extensionId, uint16 version);

    /// @notice The core ABX spec version this contract implements.
    function abxVersion() external view returns (uint16);

    /// @notice Version of an enabled extension, or 0 if not enabled.
    function extensionVersion(bytes32 extensionId) external view returns (uint16);
}
