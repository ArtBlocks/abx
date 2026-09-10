// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxSequentialMint — the canonical mint primitive an external minter targets
/// @notice The entire coupling between a minter and a sequentially-minted ABX token is this one
///         call. Token ids issue strictly in order (`0,1,2,…` — the natural supply count); the
///         caller never chooses an id (a token's metadata *is* its token id). It returns the id
///         just minted, so a minter can report exactly what it sold (in its own events) and
///         compose — without trusting `totalSupply()` (burns move it) or a contract-specific
///         cursor.
/// @dev A **capability interface, not an extension** — no version, no beacon signal — but it *is*
///      ERC-165-advertised, so a minter (or tooling) can verify a target is mintable
///      (`IERC165(token).supportsInterface(type(IAbxSequentialMint).interfaceId)`) before
///      configuring a sale, turning a would-be raw revert into a clear, up-front error. The
///      one-shot, owner-only 1/1 ({OneOfOneImage}) deliberately does **not** implement it: a
///      fixed-price minter targets open, sequential drops (a 1/1 is pre-minted and sold on the
///      secondary market). How a minter *uses* this — price, allocation, ETH vs ERC-20, sale
///      events — is a separate sale-contract concern; see the maintained minting documentation.
interface IAbxSequentialMint {
    /// @notice Mint the next sequential token to `to`.
    /// @param to Recipient of the freshly minted token.
    /// @return tokenId The id just minted (the pre-mint issuance cursor).
    function mint(address to) external returns (uint256 tokenId);
}
