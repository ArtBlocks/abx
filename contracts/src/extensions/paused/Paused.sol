// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxPaused} from "./IAbxPaused.sol";
import {PausedStorage} from "../../libraries/PausedStorage.sol";

/// @title Paused — the ABX Paused extension (Register 2), as a mixin
/// @notice A token opts into a mint safety switch by inheriting this. While paused, minting is
///         restricted to the owner (reserves / configuration / pre-launch); unpausing opens it to
///         the authorized minter. The owner sets it freely; a project usually deploys paused and
///         flips it off to go live.
/// @dev **Enforced, not a hint** — this mixin owns the flag + event + read; the *composing token*
///      wires `paused()` into its mint authorization (the owner-bypass rule lives there, since it
///      combines `paused` with `owner()` and the minter). Read surface → non-zero ERC-165 id.
///      Storage is ERC-7201 (`PausedStorage`). Self-registers its version in `_initPaused`.
abstract contract Paused is AbxBeaconCore, Ownable, IAbxPaused {
    /// @dev keccak256("abx.extension.paused") — permanent extension id. `private` so it never
    ///      collides with another extension's `ID` in a composing token.
    bytes32 private constant ID =
        0x953f3b4aac717f9d6e4f747d3bd6a42608728478e6b398a8207cb157e1fbc3a2;

    /// @dev Current implemented version (bumps when `IAbxPaused` or semantics change).
    uint16 private constant VERSION = 1;

    /// @inheritdoc IAbxPaused
    function paused() public view returns (bool) {
        return PausedStorage.layout().paused;
    }

    /// @notice Owner pauses (`true`) or unpauses (`false`) minting.
    function setPaused(bool paused_) external onlyOwner {
        PausedStorage.layout().paused = paused_;
        emit PausedStatusChanged(paused_);
    }

    /// @dev Enable the extension (announce version) + set the initial state. Call at initialize.
    ///      Emits only when deploying paused (`true`); the natural default is unpaused (`false`),
    ///      so absence of the event ⇒ not paused — mirrors the "emit non-default at init" pattern.
    function _initPaused(bool paused_) internal {
        _setExtensionVersion(ID, VERSION);
        if (paused_) {
            PausedStorage.layout().paused = true;
            emit PausedStatusChanged(true);
        }
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
            || interfaceId == type(IAbxPaused).interfaceId;
    }
}
