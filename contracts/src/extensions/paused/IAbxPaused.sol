// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxPaused — Paused extension vocabulary (Register 2)
/// @notice A mint safety switch. While **paused**, only the contract owner may mint (reserves,
///         configuration, pre-launch); the authorized minter and the public are blocked. While
///         **unpaused**, normal mint authorization applies (owner or the authorized minter). A
///         project typically deploys `paused` and the owner flips it off to open the public mint.
/// @dev **An enforced on-chain gate, not a display hint** — the composing token wires it into its
///      mint authorization (see `SeriesImage`), so a paused mint reverts. The owner always
///      bypasses it. Has a read function → a real (non-zero) ERC-165 id.
interface IAbxPaused {
    /// @notice Minting was paused (`true`) or unpaused (`false`).
    event PausedStatusChanged(bool paused);

    /// @notice Whether minting is currently paused (owner-only) — `false` = open to the minter.
    function paused() external view returns (bool);
}
