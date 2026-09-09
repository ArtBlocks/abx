// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxPrimaryPayee — Primary Payee extension vocabulary (Register 2)
/// @notice A **single** primary-sale payout destination, readable by any minter (external or
///         included). Topology-independent — the minter reads `primaryPayee()` to know where
///         proceeds go; multi-party splits are handled by pointing this at a splitter contract.
/// @dev Distinct from royalty (secondary). Projects that never sell can omit the extension (or
///      leave the payee `address(0)` = none). Has a read function → a real (non-zero) ERC-165 id.
interface IAbxPrimaryPayee {
    /// @notice The primary-sale payout address changed (`address(0)` = none).
    event PrimaryPayeeChanged(address indexed account);

    /// @notice The current primary-sale payout destination (`address(0)` = none).
    function primaryPayee() external view returns (address);
}
