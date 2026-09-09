// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxMaxInvocations} from "./IAbxMaxInvocations.sol";
import {MaxInvocationsStorage} from "../../libraries/MaxInvocationsStorage.sol";

/// @title MaxInvocations — the ABX Max Invocations extension (Register 2), as a mixin
/// @notice A token opts into a supply cap by inheriting this. The cap is the "Y" in "X of Y"
///         (distinct from the live `totalSupply()` count) and is **monotonically
///         non-increasing** after init — the promise indexers rely on for sellout + supply
///         display. The owner can only lower it, never below a `_maxInvocationsFloor()` the
///         composing token pins to the number already minted (so minted tokens can't be
///         stranded, and lowering it to the floor cleanly closes an open edition early).
/// @dev Read surface → non-zero ERC-165 id (advertised in addition to the beacon's
///      `extensionVersion`). Storage is ERC-7201 (`MaxInvocationsStorage`). Self-registers its
///      version in `_initMaxInvocations`. `_requireWithinMax` is the mint-time guard.
abstract contract MaxInvocations is AbxBeaconCore, Ownable, IAbxMaxInvocations {
    /// @dev keccak256("abx.extension.max-invocations") — permanent extension id. `private` so it
    ///      never collides with another extension's `ID` in a composing token.
    bytes32 private constant ID =
        0xfc3d02757bdfa0493eef097e21360d5e8ba1f3fe4fa2b1e37ffb556009ce40a3;

    /// @dev Current implemented version (bumps when `IAbxMaxInvocations` or semantics change).
    uint16 private constant VERSION = 1;

    /// @notice The new cap is higher than the current one (would break monotonicity).
    error MaxInvocationsIncreaseForbidden();
    /// @notice The new cap is below the floor (e.g. tokens already minted) — would strand supply.
    error MaxInvocationsBelowFloor();
    /// @notice A mint would exceed the cap.
    error MaxInvocationsReached();
    /// @notice The cap may never be zero — a zero cap can never be raised, so it bricks minting
    ///         permanently. To close a drop early, lower the cap to the number already minted.
    error InvalidMaxInvocations();

    /// @inheritdoc IAbxMaxInvocations
    function maxInvocations() public view returns (uint256) {
        return MaxInvocationsStorage.layout().maxInvocations;
    }

    /// @notice Owner lowers the supply cap (never raises it, never below the floor, never to zero).
    function setMaxInvocations(uint256 newMax) external onlyOwner {
        MaxInvocationsStorage.Layout storage l = MaxInvocationsStorage.layout();
        // Zero is a state every `initialize` explicitly forbids, and the setter used to be able to
        // reach it — permanently, since the cap is monotonically non-increasing and so can never
        // come back up. That is a bricked project reachable by one ordinary owner call with a
        // plausible intent ("close the edition"). Closing an edition early is
        // `setMaxInvocations(totalSupply())`, which the floor already permits.
        if (newMax == 0) revert InvalidMaxInvocations();
        if (newMax > l.maxInvocations) revert MaxInvocationsIncreaseForbidden();
        if (newMax < _maxInvocationsFloor()) revert MaxInvocationsBelowFloor();
        l.maxInvocations = newMax;
        emit MaxInvocationsUpdated(newMax);
    }

    /// @dev Enable the extension (announce version) + set the initial cap. Call at initialize.
    ///      No monotonic/floor check here — this is the initial value, not a change.
    function _initMaxInvocations(uint256 max) internal {
        _setExtensionVersion(ID, VERSION);
        MaxInvocationsStorage.layout().maxInvocations = max;
        emit MaxInvocationsUpdated(max);
    }

    /// @dev The lowest the cap may be lowered to. Default 0; a composing token overrides this to
    ///      the live minted count (`totalSupply()`) so a decrease can't strand minted tokens.
    function _maxInvocationsFloor() internal view virtual returns (uint256) {
        return 0;
    }

    /// @dev Mint-time guard: revert unless `id` is within the cap (ids are 0-indexed, so a valid
    ///      id is strictly less than the cap). Callers mint sequential ids 0..maxInvocations-1.
    function _requireWithinMax(uint256 id) internal view {
        if (id >= MaxInvocationsStorage.layout().maxInvocations) revert MaxInvocationsReached();
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
            || interfaceId == type(IAbxMaxInvocations).interfaceId;
    }
}
