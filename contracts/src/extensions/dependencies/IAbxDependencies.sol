// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxDependencies — Dependencies extension vocabulary (Register 2)
/// @notice The ordered **code** libraries a script needs (e.g. p5js at 1.0.0, as the ref
///         `"p5js"..."1.0.0"`). Ordered, with no "primary" event — index 0 = the runtime, by
///         generator convention. The registry pointer is **soft and non-validating**: never
///         enforced (if it vanished, the project still declares its needs), but
///         resolution-meaningful (disambiguates a name-and-version ref; a content-hash registry
///         makes resolution verifiable). Loaded assets (images, data on IPFS/Arweave) are
///         **params**, not dependencies.
interface IAbxDependencies {
    /// @notice How a dependency reference resolves.
    enum Resolution {
        Registry, // `ref` = a registry `name@version` (readable-ASCII bytes32)
        OnChain // `ref` = a contract address, left-aligned in bytes32
    }

    /// @notice The dependency at `index` was added or changed.
    event DependencyUpdated(uint256 index, Resolution resolution, bytes32 indexed ref);

    /// @notice The LAST dependency was removed (the list stays dense; order is load-bearing).
    event DependencyRemoved(uint256 index);

    /// @notice The resolving registry pointer was set (soft, non-validating).
    event DependencyRegistrySet(address indexed registry);

    /// @notice The dependency set is frozen permanently.
    event DependenciesLocked();

    /// @notice Number of declared dependencies.
    function dependencyCount() external view returns (uint256);

    /// @notice The dependency at `index`.
    function dependencyByIndex(uint256 index)
        external
        view
        returns (Resolution resolution, bytes32 ref);

    /// @notice The soft registry pointer (`address(0)` = none).
    function dependencyRegistry() external view returns (address);

    /// @notice Whether the dependency set is permanently frozen.
    function dependenciesLocked() external view returns (bool);
}
