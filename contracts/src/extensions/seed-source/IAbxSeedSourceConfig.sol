// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxSeedSourceConfig — Seed Source extension vocabulary (Register 2)
/// @notice Mint-time randomness as **configuration, not hard-coded token logic**: the token
///         stores a seed-source address; at mint it calls `IAbxSeedSource.seed(tokenId, to)`
///         and persists the result as the token's `seed` param (`TokenParamConfigured`,
///         `updatedBy` = the source). Opt-out is first-class: zero (or omitting the extension)
///         = no mint-time seed — post-mint assignment under a schema, creator-curated seeds, or
///         non-generative code.
/// @dev **Assigned once, then settled.** The mint-time write is the token's own internal path,
///      outside schema auth. Once assigned, `seed` is immutable unless a Configurable Params
///      schema explicitly authorizes reconfiguration — absent one, no one (owner included) may
///      rewrite it. Changing the source affects **future mints only** — assigned seeds are
///      settled. That promise is what lets a collector trust a generative mint without reading
///      the implementation.
interface IAbxSeedSourceConfig {
    /// @notice The seed source was set (non-zero ⇒ every mint derives a `seed`) or cleared.
    event SeedSourceSet(address indexed seedSource);

    /// @notice The current seed source (`address(0)` = no mint-time seed).
    function seedSource() external view returns (address);
}
