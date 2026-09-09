// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title EditionSupplyStorage — per-id supply cap, ERC-7201 namespaced
/// @notice Backing storage for the Edition Supply extension: `editionSize`'s DEFAULT cap
///         (`0` = every un-overridden id is an open edition, uncapped) plus any per-id explicit
///         override an owner has set via `setMaxSupply`. Distinct from `Erc1155SupplyStorage`'s
///         live per-id count — this holds only the *ceiling* ("Y" in "X of Y" for one id),
///         mirroring how `MaxInvocationsStorage` is the 721 cap sibling of the unconditional,
///         core-level `SupplyStorage`. Namespaced so it never collides with the ERC-1155 base or
///         other mixins.
/// @dev `overridden[id]` disambiguates "no explicit cap yet ⇒ read `defaultCap`" from "explicitly
///      set to a literal value, including a literal `0`" — see {EditionSupply}'s class-level dev
///      note on why the "0 = open" overload applies only before the first override.
library EditionSupplyStorage {
    /// @custom:storage-location erc7201:abx.storage.edition-supply
    struct Layout {
        uint256 defaultCap; // editionSize from init; 0 = every un-overridden id is open (uncapped)
        mapping(uint256 => uint256) capOverride; // explicit per-id cap once overridden[id] is true
        mapping(uint256 => bool) overridden; // true once setMaxSupply(id, ...) has been called for id
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.edition-supply")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xc4960b2fd926543d3aa3e916a4274bd00c974a1fb001ba681de20ef746101900;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
