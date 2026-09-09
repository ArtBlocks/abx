// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IDelegateRegistry — the delegate.xyz v2 surface ABX consumes
/// @notice The one read the Configurable Params TokenOwner auth leg needs: "may `to` act for
///         `from` on this token?" The v2 registry resolves every delegation granularity behind
///         it (all-wallet, per-contract, per-token), so ABX never enumerates delegation types.
///         Canonical v2 deployment (same address on every chain, CREATE2):
///         `0x00000000000000447e69651d841bD8D104Bed493`.
interface IDelegateRegistry {
    /// @notice Whether `to` is a delegate of `from` for `contract_` / `tokenId` under `rights`
    ///         (`bytes32(0)` = rights-agnostic — matches unscoped delegations).
    function checkDelegateForERC721(
        address to,
        address from,
        address contract_,
        uint256 tokenId,
        bytes32 rights
    ) external view returns (bool);
}
