// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxEditionMint — the canonical mint primitive an external minter targets, ERC-1155
/// @notice The ERC-1155 twin of `IAbxSequentialMint`: a *different* target shape for a
///         *different* mint primitive — identified ids, per-mint amounts — not a generalization
///         of the sequential primitive. The caller names the id (there is no natural
///         "next in order" cursor once amounts-per-id are in play); the token still enforces its
///         own id-space and per-id supply-cap guards.
/// @dev A **capability interface, not an extension** — no version, no beacon signal — but it *is*
///      ERC-165-advertised, so a minter (or tooling) can verify a target is mintable
///      (`IERC165(token).supportsInterface(type(IAbxEditionMint).interfaceId)`) before
///      configuring a sale, turning a would-be raw revert into a clear, up-front error. Same
///      token-side auth as `IAbxSequentialMint`: the owner always may; the assigned minter only
///      while unpaused. No `mintMany` — every ABX token is `Multicallable`, so batching many
///      ids/amounts is multicall's job, not the primitive's.
///      [`OneOfOneEdition`](../tokens/OneOfOneEdition.sol) keeps this same uniform signature but
///      reverts unless `id == 0` — its id space is fixed to the single work. How a minter
///      *uses* this — price, allocation, ETH vs ERC-20, sale events — is a separate sale-contract
///      concern; see the maintained minting documentation.
interface IAbxEditionMint {
    /// @notice Mint `amount` copies of `id` to `to`.
    /// @param to Recipient of the freshly minted copies.
    /// @param id The edition id to mint (the caller names it; not an auto-assigned cursor).
    /// @param amount Number of copies of `id` to mint (must be > 0).
    function mint(address to, uint256 id, uint256 amount) external;
}
