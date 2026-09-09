// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxExternalMinter — External Minter extension vocabulary (Register 2)
/// @notice Minting delegated to **a single** external contract: the event announces the one
///         address authorized to mint (beyond the owner), so an indexer knows exactly which
///         address to watch for sale activity. **Absence of this extension (or a zero minter) =
///         included / diamond minting** (mint shows only as `Transfer` from `0x0`, nothing
///         external to watch).
/// @dev Deliberately **one** minter, not a set: it is a single enumerable slot (`minter()`),
///      trivially reconstructable, with no lingering-authorization footgun — setting a new minter
///      replaces the old atomically. Any need for *multiple* sale mechanics is composed
///      **downstream**, inside the minter contract (a router / "minter filter" that fans out to
///      many mechanics), never by widening the core to a set. Minter internals — price, schedule,
///      gating, mechanic — are off-protocol; the protocol's only concern is *which address may
///      mint* (here) and *where proceeds go* (Primary Payee). Has a read function → a real
///      (non-zero) ERC-165 id.
interface IAbxExternalMinter {
    /// @notice The authorized minter was set (`address(0)` = cleared, i.e. owner-only minting).
    event MinterSet(address indexed minter);

    /// @notice The current authorized minter (`address(0)` = none; owner mints directly).
    function minter() external view returns (address);
}
