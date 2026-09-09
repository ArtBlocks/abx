// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxDependencies} from "./IAbxDependencies.sol";
import {AbxCodeDelegate} from "../code-custody/AbxCodeDelegate.sol";
import {AbxCodeLib} from "../../libraries/AbxCodeLib.sol";

/// @title Dependencies — the ABX Dependencies extension (Register 2), as a mixin
/// @notice A token opts into declaring its script's code libraries by inheriting this: an
///         ordered list (index 0 = the runtime, by generator convention), written/replaced by
///         index, appendable, poppable from the end, plus a soft registry pointer and a
///         permanent lock. Pairs with {OnChainScript}: deps in order → the script.
/// @dev Read surface → non-zero ERC-165 id. Storage is ERC-7201 (`DependenciesStorage`).
///      Self-registers its version in `_initDependencies`. Both the write paths **and the reads**
///      live in {AbxCodeLib} — a shared external library, delegatecalled, so storage stays in this
///      token's namespace and events log from the token (EIP-170 is why it's a library). The reads
///      go through {AbxCodeDelegate}'s raw-calldata passthrough rather than typed calls: see that
///      contract for why, and for the ABI coupling it creates.
abstract contract Dependencies is AbxBeaconCore, Ownable, AbxCodeDelegate, IAbxDependencies {
    /// @dev keccak256("abx.extension.dependencies") — permanent extension id.
    bytes32 private constant ID =
        0xd50d7b8118c4a0d7d74a937e55e5872032e5727784c397383d9b9f28ff4f0b1d;

    /// @dev Current implemented version (bumps when the interface or semantics change).
    uint16 private constant VERSION = 1;

    /// @notice Write index must be ≤ count (replace or append); reads must be < count.
    /// @dev Kept declared here (not thrown here) so it stays in every composing token's ABI: both
    ///      the writes and the bounds-checked `dependencyByIndex` read now revert from
    ///      {AbxCodeLib}, whose identically-named error has the identical selector.
    error DependencyIndexOutOfRange();

    /// @notice Owner writes/replaces the dependency at `index` (`== count` appends).
    function setDependency(uint256 index, Resolution resolution, bytes32 ref) external onlyOwner {
        AbxCodeLib.setDependency(index, resolution, ref);
    }

    /// @notice Owner removes the LAST dependency (the list stays dense; order is load-bearing).
    function removeLastDependency() external onlyOwner {
        AbxCodeLib.removeLastDependency();
    }

    /// @notice Owner points at a resolving registry (soft, non-validating; zero clears).
    function setDependencyRegistry(address registry) external onlyOwner {
        AbxCodeLib.setDependencyRegistry(registry);
    }

    /// @notice Owner freezes the dependency set (and registry pointer) permanently.
    function lockDependencies() external onlyOwner {
        AbxCodeLib.lockDependencies();
    }

    /// @inheritdoc IAbxDependencies
    function dependencyCount() external view returns (uint256) {
        _delegateCodeRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxDependencies
    function dependencyByIndex(uint256 /* index */ )
        external
        view
        returns (Resolution, /* resolution */ bytes32 /* ref */ )
    {
        _delegateCodeRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxDependencies
    function dependencyRegistry() external view returns (address) {
        _delegateCodeRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxDependencies
    function dependenciesLocked() external view returns (bool) {
        _delegateCodeRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @dev Enable the extension (announce version). Call at initialize.
    function _initDependencies() internal {
        _setExtensionVersion(ID, VERSION);
    }

    /// @notice ERC-165: the core base (165 + beacon) + this extension's read interface.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbxBeaconCore)
        returns (bool)
    {
        return AbxBeaconCore.supportsInterface(interfaceId)
            || interfaceId == type(IAbxDependencies).interfaceId;
    }
}
