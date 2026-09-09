// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title ContractURIStorage — contract (collection) metadata URI config, ERC-7201 namespaced
/// @notice Backing storage for the `ContractURI` strategy: the ERC-7572 collection-URI
///         resolution config — a resolver `base` (the off-chain pointer is *derived* from it
///         via the protocol path grammar), an optional full-URI `override_` (a fixed
///         locator, e.g. an `ipfs://` collection document), an optional on-chain `renderer`
///         (non-zero ⇒ resolve on-chain via {IAbxMetadataRenderer}), and a `locked` freeze.
///         Separate from `CollectionMetadataLib` (name/symbol) because the URI has a
///         resolution *strategy* while name/symbol are always-stored identity. Namespaced so
///         it never collides with the ERC-721 base or other mixins.
library ContractURIStorage {
    /// @custom:storage-location erc7201:abx.storage.contract-uri
    struct Layout {
        string base; // resolver base incl. route prefix (e.g. https://host/c); pointer = {base}/{chainId}/{address}
        string override_; // full-URI override; non-empty ⇒ wins over the derived base path
        address renderer; // non-zero ⇒ resolve on-chain via this IAbxMetadataRenderer
        bool locked; // freeze the URI config (base + override + renderer) forever
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.contract-uri")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xad7f964ded3ab37f504a36affe565a0c46e794355a5fbb8c096f7c853d41e700;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
