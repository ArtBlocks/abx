// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxRoyalty — Royalty extension vocabulary (Register 2)
/// @notice Declares the *full* spine vocabulary for the Royalty extension (a
///         contract may emit any subset). Each event carries the full value
///         (`basisPoints`), not a bare change-ping — so the two registers split
///         cleanly with no redundant read:
///           - Native (ABX-aware indexer): the events *are* the off-chain view —
///             reconstruct the complete royalty state (default + per-token overrides)
///             from the log alone, zero calls.
///           - Lingua franca (marketplace / on-chain payout): resolve via ERC-2981
///             `royaltyInfo`. That standard read is the *only* reason there is no ABX
///             read function here — adding one would reinvent a working standard.
/// @dev Events-only, so this interface has ERC-165 id 0x00000000 and is *not*
///      advertised via `supportsInterface`. Extension support is discovered via the
///      beacon: `extensionVersion(RoyaltyExtension.ID) != 0`. On-chain *enforcement*
///      is a separate opt-in (ERC-721-C); ABX takes no side.
interface IAbxRoyalty {
    /// @notice The contract-wide default royalty changed. Pairs with ERC-2981.
    event RoyaltyChangedForAll(address indexed account, uint16 basisPoints);

    /// @notice A per-token royalty override changed (overrides the default for that token).
    event RoyaltyChangedForToken(
        uint256 indexed tokenId, address indexed account, uint16 basisPoints
    );

    /// @notice The royalty **ceiling** was set (at deploy) or reduced. `maxBps` is the most the
    ///         contract-wide default royalty can ever be from here on — and it only ever falls, so
    ///         an indexer can serve "this collection's royalty can never exceed `maxBps`" from the
    ///         log alone, and a marketplace can surface a provable cap. Emitted at init and on every
    ///         {IAbxRoyalty}-cap reduction.
    event MaxRoyaltyBpsUpdated(uint16 maxBps);
}
