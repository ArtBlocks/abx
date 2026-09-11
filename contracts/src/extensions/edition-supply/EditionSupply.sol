// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxEditionSupply} from "./IAbxEditionSupply.sol";
import {EditionSupplyStorage} from "../../libraries/EditionSupplyStorage.sol";
import {Erc1155SupplyStorage} from "../../libraries/Erc1155SupplyStorage.sol";
import {AbxEditionLib} from "../../libraries/AbxEditionLib.sol";

/// @title EditionSupply — the ABX Edition Supply extension (Register 2), as a mixin
/// @notice A 1155 token opts into a per-id supply cap by inheriting this — the ERC-1155 analogue
///         of `MaxInvocations`, scoped per id instead of per project. `editionSize` at
///         initialize sets the DEFAULT cap every id starts with (`0` = open/uncapped); the owner
///         may later override an individual id's cap with `setMaxSupply`, which — once used for
///         that id — is monotonically non-increasing and never below that id's live
///         `totalSupply(id)` (mirrors `MaxInvocations`' floor philosophy, per id instead of
///         per project).
/// @dev **Design decision (storage split, documented per the plan's open call):** the live per-id
///      COUNTER lives in `Erc1155SupplyStorage` — a base-level library `AbxErc1155Base` writes to
///      UNCONDITIONALLY in its `_afterTokenTransfer` (mirroring `SupplyStorage`'s core,
///      always-on role for ERC-721). This extension owns only the CAP (`editionSize` default +
///      per-id overrides, in `EditionSupplyStorage`) and exposes the PUBLIC reads
///      (`totalSupply`/`exists`/`maxSupply`). Unlike ERC-721's unconditional `totalSupply()`, those
///      reads belong to the Edition Supply extension.
///      Reading the base's counter needs no inheritance coupling: both files just import the same
///      freestanding ERC-7201 library — no virtual-hook indirection needed for a plain library.
///
///      **The "0 = open" overload is default-only, never re-openable by an explicit override.**
///      Before any `setMaxSupply` call for an id, `maxSupply(id) == 0` means uncapped (the
///      `editionSize` default at birth). The MOMENT the owner calls `setMaxSupply(id, cap)` for
///      that id, `cap` becomes the LITERAL value from then on (including a literal `0`,
///      permanently closing that id — legal only while its `totalSupply(id)` is also `0`): an
///      explicit override can never reopen an id back to "unbounded", since that would be an
///      increase and break the monotonic-non-increase promise. This resolves an ambiguity the
///      plan left open (does an explicit `0` mean "open" or "shut"?) in favor of the reading that
///      keeps `setMaxSupply` unconditionally monotonic.
///
///      Read surface → non-zero ERC-165 id. Self-registers its version in `_initEditionSupply`.
abstract contract EditionSupply is AbxBeaconCore, Ownable, IAbxEditionSupply {
    /// @dev keccak256("abx.extension.edition-supply") — permanent extension id. The only NEW
    ///      extension id introduced by the ERC-1155 editions family (every other extension id is
    ///      shared, unchanged, with the 721 twins). `private` so it never collides with another
    ///      extension's `ID` in a composing token.
    bytes32 private constant ID =
        0x01b88e5b7492f4b55db15ff2d803b4fc1213570f45cf49303a4efa1f930087c2;

    /// @dev Current implemented version (bumps when `IAbxEditionSupply` or semantics change).
    uint16 private constant VERSION = 1;

    /// @notice The new cap is higher than the id's current effective cap (would break monotonicity).
    error MaxSupplyIncreaseForbidden();
    /// @notice The new cap is below the id's live `totalSupply(id)` — would strand supply.
    error MaxSupplyBelowFloor();
    /// @notice A mint would exceed the id's supply cap.
    error EditionSupplyReached();

    /// @inheritdoc IAbxEditionSupply
    function totalSupply(uint256 id) public view returns (uint256) {
        return Erc1155SupplyStorage.layout().totalSupply[id];
    }

    /// @inheritdoc IAbxEditionSupply
    function exists(uint256 id) public view returns (bool) {
        return totalSupply(id) != 0;
    }

    /// @inheritdoc IAbxEditionSupply
    function maxSupply(uint256 id) public view returns (uint256) {
        EditionSupplyStorage.Layout storage l = EditionSupplyStorage.layout();
        return l.overridden[id] ? l.capOverride[id] : l.defaultCap;
    }


    /// @notice Owner overrides `id`'s supply cap. Monotonically non-increasing once used for that
    ///         id (see the class-level dev note on the "0 = open" overload), never below the id's
    ///         live `totalSupply(id)`.
    /// @dev Branches on `overridden[id]`, NOT on `current != 0` — the latter has a hole: an id
    ///      explicitly closed to `0` also reads `current == 0`, and a naive `current != 0` guard
    ///      would then skip the increase check entirely and let a later call REOPEN it. Once
    ///      `overridden[id]` is true, `capOverride[id]` (however it reads, including a literal
    ///      `0`) is the one ceiling `cap` may never exceed — "closed" (`0`) means literally
    ///      nothing but `0` is legal from then on. Only while `overridden[id]` is still false does
    ///      the un-overridden default (`0` = open, uncapped) apply, and only a NON-zero default
    ///      constrains the first override.
    function setMaxSupply(uint256 id, uint256 cap) external virtual onlyOwner {
        // ONE implementation. This body used to live here AND in {AbxEditionLib}, with every
        // concrete edition token overriding to pick the library copy — so the mixin's copy was
        // unreachable, and three separate fixes landed in it instead of in the code that runs.
        // The mixin now delegates, and the tokens carry no override at all.
        AbxEditionLib.setMaxSupply(id, cap);
    }

    /// @dev Enable the extension (announce version) + set the default per-id cap. Call at
    ///      initialize. No monotonic/floor check here — this is the initial value, not a change.
    function _initEditionSupply(uint256 editionSize) internal {
        _setExtensionVersion(ID, VERSION);
        EditionSupplyStorage.layout().defaultCap = editionSize;
        // Announce the default, or the event spine cannot reconstruct any id's cap. Without this,
        // `editionSize` reached storage and nothing else: an id that has never been overridden
        // produces no `MaxSupplyUpdated` at all, so "no event for that id ⇒ uncapped" — the rule the
        // docs give integrators for telling an open edition from a closed one, now that
        // `maxSupply(id) == 0` is deliberately ambiguous — was simply false for every project with a
        // non-zero `editionSize`. One event at init makes the log complete again.
        emit DefaultMaxSupplySet(editionSize);
    }

    /// @dev Mint-time guard: revert if minting `amount` more copies of `id` would exceed its cap.
    ///      An un-overridden `0` default is open (uncapped) — the library skips the check entirely.
    ///
    ///      **One body, in {AbxEditionLib}, and NOT `virtual`.** This is the last of the V-01 class
    ///      and the only one that was still live in two places: `EditionCode` overrode it to the
    ///      library while `OneOfOneEdition` and `EditionImage` ran the copy that used to be here.
    ///      The bodies agreed, so nothing was broken — but the next fix to the mint-cap check had a
    ///      one-in-three chance of landing in the copy two of the three tokens do not run, on the
    ///      guard that stops an edition overselling. Dropping `virtual` is what makes a fourth
    ///      edition type unable to quietly reintroduce the split.
    ///
    ///      Verified by mutation, not by inspection: stubbing
    ///      {AbxEditionLib-requireWithinEditionCap} to `return` now fails cap assertions in
    ///      `OneOfOneEdition.t.sol`, `EditionImage.t.sol` AND `EditionCodeFactory.t.sol`. Before this
    ///      collapse it failed only the last of those.
    function _requireWithinEditionCap(uint256 id, uint256 amount) internal view {
        AbxEditionLib.requireWithinEditionCap(id, amount);
    }

    /// @notice ERC-165: the core base (165 + beacon) + this extension's read interface.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbxBeaconCore)
        returns (bool)
    {
        return AbxBeaconCore.supportsInterface(interfaceId)
            || interfaceId == type(IAbxEditionSupply).interfaceId;
    }
}
