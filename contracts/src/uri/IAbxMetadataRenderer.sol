// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxMetadataRenderer — on-chain metadata document renderer (a versioned spec impl)
/// @notice A stateless contract that assembles a token's ERC-721 metadata JSON and a
///         collection's ERC-7572 JSON entirely on-chain, by reading the token's
///         {IAbxOnChainMetadata} fields and emitting a `data:application/json` URI. A
///         token's URI strategy delegates to one of these when its renderer pointer is
///         set (non-zero ⇒ resolve on-chain), so the token needs no assembly logic of its
///         own. This is the on-chain twin of the off-chain indexer/resolver: both
///         implement one metadata spec, and {specVersion} says which.
/// @dev Stateless + shared: one deployed renderer can serve every ABX token on the chain.
///      It is the same interface-dispatch pattern as {IAbxOnChainReader}, lifted from a
///      single field's bytes to the whole document — a "reader for the entire token."
///      Called read-only; the token passes `(address(this), tokenId)` and the renderer
///      reads back through the standard metadata interface, so any token + any
///      spec-versioned renderer compose.
interface IAbxMetadataRenderer {
    /// @notice The full token metadata `data:application/json` URI for `(token, tokenId)`.
    function tokenURI(address token, uint256 tokenId) external view returns (string memory);

    /// @notice The full collection (ERC-7572) metadata `data:application/json` URI for `token`.
    function contractURI(address token) external view returns (string memory);

    /// @notice The metadata spec version this renderer implements (bumps with the spec).
    function specVersion() external view returns (uint256);
}
