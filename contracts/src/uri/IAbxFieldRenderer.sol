// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxFieldRenderer — the `renderer` representation's target: computed fields
/// @notice Where an `IAbxOnChainReader` returns *stored* bytes, a field renderer returns
///         *computed* bytes — one field's value derived from chain state (the token's params,
///         owner, anything readable): an in-chain SVG from a seed, an on-chain trait array,
///         even a full HTML document. The on-chain twin of the render node's
///         `(params) → output`. A field opts in via the `renderer` representation
///         (`value = abi.encode(address fieldRenderer)`); the off-chain resolver dispatches it
///         with an `eth_call`, the on-chain metadata renderer (v2+) with a staticcall.
/// @dev Determinism is scoped to chain state: same state → same bytes. Stateless per read;
///      never confined to canonical deployments — any contract satisfying this interface, per
///      field, per project. Collection-surface reads (no token, e.g. `contractURI`) pass
///      `tokenId = type(uint256).max`.
interface IAbxFieldRenderer {
    /// @notice Compute `field`'s value for `(token, tokenId)`.
    /// @return contentType MIME of `data` (e.g. `image/svg+xml`, `application/json`, `text/html`).
    /// @return data the field's finished bytes.
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data);
}
