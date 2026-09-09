// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxPrimaryPayee} from "./IAbxPrimaryPayee.sol";
import {PrimaryPayeeStorage} from "../../libraries/PrimaryPayeeStorage.sol";

/// @title PrimaryPayee — the ABX Primary Payee extension (Register 2), as a mixin
/// @notice A token opts into a declared primary-sale payout by inheriting this. The owner sets a
///         single destination (`address(0)` = none); any minter reads `primaryPayee()` to know
///         where proceeds go. Multi-party splits = point this at a splitter contract.
/// @dev Read surface → non-zero ERC-165 id. Storage is ERC-7201 (`PrimaryPayeeStorage`).
///      `_initPrimaryPayee` always announces the extension version (the token composes it) but
///      only emits `PrimaryPayeeChanged` when a non-zero payee is actually set, so a zero payee
///      reads cleanly as "none" without a noise event.
abstract contract PrimaryPayee is AbxBeaconCore, Ownable, IAbxPrimaryPayee {
    /// @dev keccak256("abx.extension.primary-payee") — permanent extension id. `private` so it
    ///      never collides with another extension's `ID` in a composing token.
    bytes32 private constant ID =
        0xc9177dd2f210cbd51b17bbe123e21aea380a89860c8f744cb9a234e42e452535;

    /// @dev Current implemented version (bumps when `IAbxPrimaryPayee` or semantics change).
    uint16 private constant VERSION = 1;

    /// @inheritdoc IAbxPrimaryPayee
    function primaryPayee() public view returns (address) {
        return PrimaryPayeeStorage.layout().primaryPayee;
    }

    /// @notice Owner sets (or clears, with `address(0)`) the primary-sale payout destination.
    function setPrimaryPayee(address account) external onlyOwner {
        PrimaryPayeeStorage.layout().primaryPayee = account;
        emit PrimaryPayeeChanged(account);
    }

    /// @dev Enable the extension (announce version) + set the initial payee. Call at initialize.
    ///      Emits only for a non-zero payee (zero = "none", the default, no event needed).
    function _initPrimaryPayee(address account) internal {
        _setExtensionVersion(ID, VERSION);
        if (account != address(0)) {
            PrimaryPayeeStorage.layout().primaryPayee = account;
            emit PrimaryPayeeChanged(account);
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
            || interfaceId == type(IAbxPrimaryPayee).interfaceId;
    }
}
