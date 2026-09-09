// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title CollectionMetadataLib — collection identity (name/symbol), ERC-7201 namespaced
/// @notice The always-stored ERC-721 collection identity: `name` and `symbol`. These
///         are plain strings with no resolution strategy (there is no "off-chain name"),
///         so they live in the core base — unlike `contractURI`, which is a URI with a
///         stored-vs-on-chain strategy (see `StoredContractURI`). Clones can't use
///         immutables for strings, so they live in storage; namespaced to avoid
///         colliding with the ERC-721 base or other mixins.
library CollectionMetadataLib {
    /// @custom:storage-location erc7201:abx.storage.collection-metadata
    struct Layout {
        string name; // ERC-721 collection name
        string symbol; // ERC-721 collection symbol
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.collection-metadata")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x74f07161264a0e552ca4d6551702023250b600e9654b0fc90b03d20d4b241e00;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
