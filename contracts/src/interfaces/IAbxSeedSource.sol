// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxSeedSource — the seed-derivation target a token calls at mint
/// @notice The randomizer shape: the token (the caller — `msg.sender` is the project contract)
///         asks for a seed for `(tokenId, to)` and persists the result as the token's `seed`
///         param. **Non-view on purpose** — sources may keep state (commit-reveal, curated
///         queues, oracle-fed). The canonical pseudorandom source is {AbxSeedSource}; a
///         project may point at any contract satisfying this interface. Like
///         {IAbxSequentialMint}, this is a capability interface, not an extension — the
///         extension (event + read) lives on the token; see `IAbxSeedSourceConfig`.
interface IAbxSeedSource {
    /// @notice Derive the seed for a mint of `tokenId` to `to`. Called by the token at mint.
    function seed(uint256 tokenId, address to) external returns (bytes32);
}
