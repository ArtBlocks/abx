// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxSeedSourceConfig} from "./IAbxSeedSourceConfig.sol";
import {IAbxSeedSource} from "../../interfaces/IAbxSeedSource.sol";
import {SeedSourceStorage} from "../../libraries/SeedSourceStorage.sol";
import {AbxParamsLib} from "../../libraries/AbxParamsLib.sol";

/// @title SeedSourceExtension — the ABX Seed Source extension (Register 2), as a mixin
/// @notice A token opts into configurable mint-time randomness by inheriting this. The mixin
///         owns the address + event + read; the *composing token* wires `_drawSeed` into its
///         mint path and persists the result as the `seed` param (with the settled-once rule —
///         see the token's `_checkParamWrite`). Set at `initialize`, owner-settable after;
///         changing the source affects future mints only.
/// @dev Read surface → non-zero ERC-165 id. Storage is ERC-7201 (`SeedSourceStorage`).
///      Self-registers its version in `_initSeedSource`.
abstract contract SeedSourceExtension is AbxBeaconCore, Ownable, IAbxSeedSourceConfig {
    /// @dev keccak256("abx.extension.seed-source") — permanent extension id.
    bytes32 private constant ID =
        0xadf163e8ee3434ba3f5fc073112c18881cd3752509cc86560b1bb64d8aa4f687;

    /// @dev Current implemented version (bumps when the interface or semantics change).
    uint16 private constant VERSION = 1;

    /// @inheritdoc IAbxSeedSourceConfig
    function seedSource() public view returns (address) {
        return SeedSourceStorage.layout().seedSource;
    }

    /// @notice Owner sets/clears the seed source. Future mints only — assigned seeds are settled.
    function setSeedSource(address source) external onlyOwner {
        SeedSourceStorage.layout().seedSource = source;
        emit SeedSourceSet(source);
    }

    /// @dev Enable the extension (announce version) + set the initial source. Call at
    ///      initialize. Emits only when non-zero — absence of the event ⇒ no mint-time seed
    ///      (mirrors the "emit non-default at init" pattern).
    function _initSeedSource(address source) internal {
        _setExtensionVersion(ID, VERSION);
        if (source != address(0)) {
            SeedSourceStorage.layout().seedSource = source;
            emit SeedSourceSet(source);
        }
    }

    /// @dev Draw a seed for a mint, or report there's nothing to draw (source unset). The
    ///      composing token persists the result as the `seed` param, `updatedBy` = the source.
    function _drawSeed(uint256 tokenId, address to)
        internal
        returns (bool drawn, bytes32 value, address source)
    {
        source = SeedSourceStorage.layout().seedSource;
        if (source == address(0)) return (false, bytes32(0), address(0));
        // Only latch when a seed is genuinely about to exist. A project with no seed source never
        // draws one, so its `seed` key stays open to a later declaration — the commitment is about
        // seeds that exist, not about having minted.
        AbxParamsLib.latchSeedAssignment();
        return (true, IAbxSeedSource(source).seed(tokenId, to), source);
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
            || interfaceId == type(IAbxSeedSourceConfig).interfaceId;
    }
}
