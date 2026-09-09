// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title TokenURIStorage — token metadata URI config, ERC-7201 namespaced
/// @notice Backing storage for the general token-URI strategy (`TokenURI`). Holds the
///         resolution config: a resolver `base` (the off-chain pointer is *derived* from it
///         via the protocol path grammar — see {TokenURI}), an optional on-chain `renderer`
///         (non-zero ⇒ resolve on-chain via {IAbxMetadataRenderer}), per-token full-URI
///         overrides, and a `locked` flag freezing all of it forever. Namespaced so it never
///         collides with the ERC-721 base or other mixins.
/// @dev This is the *metadata URI* config (where the token's JSON resolves from), not
///      "content" — the spine reserves *content* for the work bytes/code itself, which
///      lives in the on-chain-metadata fields. The strategy is cardinality-neutral: one
///      `base` derives every token's pointer (1/1 or many), and `tokenOverride[id]` pins a
///      single token to a fixed locator when needed.
library TokenURIStorage {
    /// @custom:storage-location erc7201:abx.storage.token-uri
    struct Layout {
        string base; // resolver base incl. route prefix (e.g. https://host/t); pointer = {base}/{chainId}/{address}/{tokenId}
        address renderer; // non-zero ⇒ resolve on-chain via this IAbxMetadataRenderer
        bool locked; // freeze the URI config (base + renderer + all overrides) forever
        mapping(uint256 => string) tokenOverride; // per-token full-URI override; non-empty ⇒ wins over the derived base path
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.token-uri")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x3ddb67fd36df1b660b70192b8fc57a1c237e14d9a15f3d437d61fe4ee5238200;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
