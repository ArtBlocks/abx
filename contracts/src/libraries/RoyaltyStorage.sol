// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title RoyaltyStorage — the owner-set royalty ceiling, ERC-7201 namespaced
/// @notice Backing storage for {RoyaltyExtension}'s cap on the contract-wide default royalty. The
///         cap is chosen by the creator at deploy (0–10000 bps, i.e. up to 100%) and can only ever
///         be **reduced** afterward — never raised. A monotonic-down ceiling is itself a
///         buyer-readable guarantee: reading `maxRoyaltyBps()` tells a collector the most this
///         collection's resale royalty can ever be, and that number can only get smaller. It matters
///         most on an enrolled ERC-721C collection, where royalties are enforced on transfer — a low,
///         can-only-fall cap is a provable "no royalty rug".
/// @dev Reconstructable from `MaxRoyaltyBpsUpdated` (emitted at init and on every reduction). The
///      *active* royalty (receiver + rate) lives in Solady's ERC-2981 storage, resolved via
///      `royaltyInfo`; this library holds only the ceiling. Namespaced so it never collides with the
///      ERC-2981 slots, the ERC-721 base, or other mixins.
library RoyaltyStorage {
    /// @custom:storage-location erc7201:abx.storage.royalty
    struct Layout {
        uint16 maxRoyaltyBps; // owner-set ceiling in basis points; set at init, reduce-only after
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.royalty")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x9acc624810693f9690f8fc3aa0075ea7214effe5b6653d1b0d3d42d9113c2000;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
