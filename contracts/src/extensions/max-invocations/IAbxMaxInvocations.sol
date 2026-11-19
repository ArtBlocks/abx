// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxMaxInvocations — Max Invocations extension vocabulary (Register 2)
/// @notice The project's supply *cap* — the ceiling in "X of Y", distinct from the live
///         `totalSupply()` count at the core base. The event carries the full value, so an
///         ABX-aware indexer reconstructs the cap from the log alone; the read surface serves
///         direct callers and marketplaces.
/// @dev The semantic contract an indexer relies on WITHOUT reading the implementation:
///      `maxInvocations` is **monotonically non-increasing**. It powers sellout and "X of Y"
///      display; an implementation that allowed increases would be misusing this event and
///      must define its own. Has a read function → a real (non-zero) ERC-165 id.
interface IAbxMaxInvocations {
    /// @notice The supply cap changed. Only ever decreasing (monotonic).
    event MaxInvocationsUpdated(uint256 maxInvocations);

    /// @notice The current supply cap. On an ERC-721 series, the most token ids that can ever be
    ///         issued. On an ERC-1155 edition, the most distinct ids (works) that can ever be
    ///         minted; copies per id are capped separately (`IAbxEditionSupply.maxSupply`).
    function maxInvocations() external view returns (uint256);
}
