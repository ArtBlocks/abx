// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title ITransferValidator1155 — the ERC-1155C validator surface an enrolled creator token calls
/// @notice The ecosystem-standard 1155 validation entrypoint (per Limit Break's
///         creator-token-standards): unlike the 721C surface, this is NOT a view — the validator
///         may record state per transfer. A policy violation reverts; the revert bubbles and
///         blocks the transfer. Called once per `(id, amount)` pair — the ecosystem standard has
///         no batch validator entrypoint, so a batch transfer loops, one call per id.
interface ITransferValidator1155 {
    /// @notice Validate a transfer of `amount` of `id` from `from` to `to`, initiated by `caller`.
    function validateTransfer(address caller, address from, address to, uint256 id, uint256 amount)
        external;
}
