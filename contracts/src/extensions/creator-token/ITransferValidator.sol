// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title ITransferValidator — the validator surface an enrolled creator token calls per transfer
/// @notice The ecosystem-standard validation entrypoint (a view — the token staticcalls it, so a
///         validator can never mutate state mid-transfer). A policy violation reverts; the revert
///         bubbles and blocks the transfer.
interface ITransferValidator {
    /// @notice Validate a transfer of `tokenId` from `from` to `to`, initiated by `caller`.
    function validateTransfer(address caller, address from, address to, uint256 tokenId)
        external
        view;
}
