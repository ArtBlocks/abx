// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxExternalMinter} from "./IAbxExternalMinter.sol";
import {ExternalMinterStorage} from "../../libraries/ExternalMinterStorage.sol";

/// @title ExternalMinter — the ABX External Minter extension (Register 2), as a mixin
/// @notice A token opts into delegated minting by inheriting this. The owner sets **one** minter
///         address (a fixed drop contract, an auction, an allowlist gate, or a router that itself
///         fans out to several mechanics); that address may call the token's mint functions
///         alongside the owner. Setting a new minter replaces the previous one; setting
///         `address(0)` clears it (back to owner-only). Minter internals are the minter's own —
///         off-protocol.
/// @dev **Single minter by design** (see {IAbxExternalMinter}) — one slot, enumerable via
///      `minter()`, no set to leak authorizations. Read surface → non-zero ERC-165 id. Storage is
///      ERC-7201 (`ExternalMinterStorage`). Self-registers its version in `_initExternalMinter`.
///
///      **This mixin holds the minter slot, not the mint-time auth check.** Each composing token
///      defines its own `_requireMintAuth`, and that check is strictly stronger than "owner or
///      minter": it also enforces `paused()`, so the authorized minter cannot mint through a pause.
///      A weaker `_requireMinterOrOwner` used to live here, unused, with a comment claiming it was
///      the live gate — a trap for the next token to compose this, since following the comment
///      would have silently dropped the pause. It is gone; `_requireMintAuth` is the only auth on
///      any mint path. Like it, nothing here reads anything but the real `msg.sender` (no ERC-2771).
abstract contract ExternalMinter is AbxBeaconCore, Ownable, IAbxExternalMinter {
    /// @dev keccak256("abx.extension.external-minter") — permanent extension id. `private` so it
    ///      never collides with another extension's `ID` in a composing token.
    bytes32 private constant ID =
        0xe07e94f8a0badc701a9aab7c6b66e86d7a9ff5e361256a73d13a9251887d9a06;

    /// @dev Current implemented version (bumps when `IAbxExternalMinter` or semantics change).
    uint16 private constant VERSION = 1;

    /// @notice Caller is neither the owner nor the authorized minter.
    error NotMinterOrOwner();

    /// @inheritdoc IAbxExternalMinter
    function minter() public view returns (address) {
        return ExternalMinterStorage.layout().minter;
    }

    /// @notice Owner sets (or clears, with `address(0)`) the single authorized minter.
    function setMinter(address newMinter) external onlyOwner {
        ExternalMinterStorage.layout().minter = newMinter;
        emit MinterSet(newMinter);
    }

    /// @dev Enable the extension (announce version) + set the initial minter. Call at initialize.
    ///      Emits only for a non-zero minter (zero = "none", the default, no event needed).
    function _initExternalMinter(address minter_) internal {
        _setExtensionVersion(ID, VERSION);
        if (minter_ != address(0)) {
            ExternalMinterStorage.layout().minter = minter_;
            emit MinterSet(minter_);
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
            || interfaceId == type(IAbxExternalMinter).interfaceId;
    }
}
