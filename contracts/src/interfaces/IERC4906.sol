// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IERC4906 — Metadata update event extension (Register 1 standard)
/// @notice The "re-index me" ping marketplaces honor. ERC-165 id: 0x49064906.
interface IERC4906 {
    /// @notice The metadata of `_tokenId` changed.
    event MetadataUpdate(uint256 _tokenId);

    /// @notice The metadata of tokens in `[_fromTokenId, _toTokenId]` changed.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
}
