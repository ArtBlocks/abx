// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxEditionSupply — Edition Supply extension vocabulary (Register 2)
/// @notice The ERC-1155 analogue of `IAbxMaxInvocations`, scoped per id instead of per project:
///         each id's max supply — the ceiling in "X of Y" for THAT work — distinct from the
///         live `totalSupply(id)` count. `editionSize` at `initialize` sets the default cap for
///         every id at birth (`0` = open edition, uncapped); `setMaxSupply(id, cap)` overrides an
///         individual id thereafter. The event carries the full value, so an ABX-aware indexer
///         reconstructs each id's cap from the log alone; the read surface serves direct callers
///         and marketplaces.
/// @dev The semantic contract an indexer relies on WITHOUT reading the implementation: once an id
///      has been explicitly overridden (`setMaxSupply` called for it at least once), its cap is
///      monotonically non-increasing and never below that id's `totalSupply(id)`. Has a read
///      function → a real (non-zero) ERC-165 id.
interface IAbxEditionSupply {
    /// @notice An id's supply cap changed. Only ever decreasing once explicitly set (monotonic).
    event MaxSupplyUpdated(uint256 indexed id, uint256 cap);

    /// @notice The collection's DEFAULT per-id cap, announced once at initialize (`0` = open).
    /// @dev Emitted so the spine reconstructs every id's cap without a state read: an id with no
    ///      `MaxSupplyUpdated` of its own carries this default. Reading `maxSupply(id) == 0` alone
    ///      cannot distinguish "never capped" from "explicitly closed" — the log can.
    event DefaultMaxSupplySet(uint256 cap);

    /// @notice The number of copies of `id` that exist right now (minted − burned).
    function totalSupply(uint256 id) external view returns (uint256);

    /// @notice Whether any copy of `id` currently exists (`totalSupply(id) > 0`).
    function exists(uint256 id) external view returns (bool);

    /// @notice The current supply cap for `id` (`0` = open/uncapped, until explicitly overridden).
    /// @dev `0` is overloaded: it means **open/uncapped** for an id never explicitly capped, and
    ///      **closed** for an id deliberately overridden to zero. The two are indistinguishable
    ///      from this getter alone, and deliberately so — a dedicated on-chain getter cost ~200 B
    ///      on `EditionCode`, which has none to spare. The distinction lives in the event spine
    ///      instead, which is where this protocol reconstructs state from anyway:
    ///      `MaxSupplyUpdated(id, 0)` ⇒ explicitly closed; no such event for that id ⇒ open.
    ///      An integrator that renders a buy button must consult the log, not just this value.
    function maxSupply(uint256 id) external view returns (uint256);

}
