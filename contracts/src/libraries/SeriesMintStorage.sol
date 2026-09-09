// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title SeriesMintStorage — the sequential mint cursor, ERC-7201 namespaced
/// @notice Backing storage for a Series token's monotonic mint counter: `nextTokenId` is the id
///         the next mint will assign, so token ids are issued strictly in order (`0,1,2,…`) — the
///         natural supply-count invariant. Distinct from the live `totalSupply()` (which a burn
///         would decrement) and from the metadata-id mapping: this is *issuance order* only.
///         Namespaced so it never collides with the ERC-721 base or other mixins.
library SeriesMintStorage {
    /// @custom:storage-location erc7201:abx.storage.series-mint
    struct Layout {
        uint256 nextTokenId; // id the next mint assigns; only ever increases
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.series-mint")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xb506e4dec18c722536887b2b4ba51ff118b450c2697ed71164a039b9c3eceb00;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
