// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {IAbxBeacon} from "../interfaces/IAbxBeacon.sol";
import {AbxVersion} from "../libraries/AbxVersion.sol";
import {BeaconStorage} from "../libraries/BeaconStorage.sol";

/// @title AbxBeaconCore — the required ABX core: discovery beacon + extension versioning + ERC-165 base
/// @notice Every ABX contract and every extension mixin builds on this. It owns the
///         one required event (`AbxDeployed`), the per-extension version registry
///         (`AbxExtensionVersionSet` / `extensionVersion`), and the ERC-165 base (165
///         itself + the beacon read-surface). Extension mixins call
///         `_setExtensionVersion` to self-register; concrete tokens call
///         `_emitAbxDeployed` once at initialize.
/// @dev `supportsInterface` is `virtual`; each layer (token base, extension mixins)
///      overrides it and ORs in its own ids — so ERC-165 reflects exactly what a given
///      contract composes. Solady's leaf implementations don't super-chain, so
///      composition is by explicit OR in the most-derived contract. State lives in an
///      ERC-7201 namespace (`BeaconStorage`), so the core holds no sequential slot —
///      no reliance on inheritance-layout order anywhere in an ABX contract.
abstract contract AbxBeaconCore is IAbxBeacon {
    /// @inheritdoc IAbxBeacon
    function abxVersion() external pure returns (uint16) {
        return AbxVersion.CORE_VERSION;
    }

    /// @inheritdoc IAbxBeacon
    function extensionVersion(bytes32 extensionId) external view returns (uint16) {
        return BeaconStorage.layout().extensionVersion[extensionId];
    }

    /// @dev Emit the required discovery beacon. Call once, at initialize.
    function _emitAbxDeployed() internal {
        emit AbxDeployed(AbxVersion.CORE_VERSION);
    }

    /// @dev Enable/bump an extension and announce it. Called by extension mixins.
    function _setExtensionVersion(bytes32 extensionId, uint16 version) internal {
        BeaconStorage.layout().extensionVersion[extensionId] = version;
        emit AbxExtensionVersionSet(extensionId, version);
    }

    /// @notice ERC-165 base: 165 itself + the (function-bearing) beacon interface.
    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == type(IAbxBeacon).interfaceId;
    }
}
