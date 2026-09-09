// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title ExternalMinterStorage — the single authorized minter, ERC-7201 namespaced
/// @notice Backing storage for the External Minter extension: **one** address authorized to mint
///         beyond the owner (`address(0)` = none). A single slot — trivially enumerable and
///         reconstructable from the `MinterSet` spine, with no membership-set bookkeeping.
///         Namespaced so it never collides with the ERC-721 base or other mixins.
library ExternalMinterStorage {
    /// @custom:storage-location erc7201:abx.storage.external-minter
    struct Layout {
        address minter; // the one authorized minter; address(0) = owner-only minting
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.external-minter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xfd2506f658934c1c6361cda4a2bf52f43609927816d1376555d0cb1ae593ba00;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
