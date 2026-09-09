// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {ERC2981} from "solady/tokens/ERC2981.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxRoyalty} from "./IAbxRoyalty.sol";
import {RoyaltyStorage} from "../../libraries/RoyaltyStorage.sol";

/// @title RoyaltyExtension — the ABX Royalty extension (Register 2), as a composable mixin
/// @notice A token opts into royalties by inheriting this. The mixin *is* the whole
///         extension: its identity (`ID`/`VERSION`), its event vocabulary (`IAbxRoyalty`),
///         and its logic — a capped, owner-settable contract-wide default layered over
///         Solady's ERC-2981 (which provides the storage + `royaltyInfo` resolution
///         read). Royalty stays the thinnest extension precisely because ERC-2981 does
///         the heavy lifting; richer extensions (Params, On-Chain Script) carry their
///         own storage libraries too.
/// @dev Reads resolve via ERC-2981 `royaltyInfo`; the rate also rides each event, so
///      ABX indexers reconstruct from the log with no call.
///
///      **The cap (`maxRoyaltyBps`) is chosen by the creator at deploy — 0 to 10000 bps (up to
///      100%) — and is REDUCE-ONLY thereafter.** It was a hard-coded 10% constant; it is now stored
///      state, so a creator can pick a ceiling that fits their project and, crucially, can only ever
///      lower it. A monotonic-down cap is a buyer-readable guarantee: `maxRoyaltyBps()` is the most
///      resale royalty this collection can ever charge, and it only falls — which on an enrolled
///      ERC-721C collection (royalties enforced on transfer) is a provable "no royalty rug". Tooling
///      defaults the initial cap to 10%; a creator opts higher explicitly. v2 for this change.
abstract contract RoyaltyExtension is AbxBeaconCore, ERC2981, Ownable, IAbxRoyalty {
    /// @dev keccak256("abx.extension.royalty") — permanent extension id. `private` so it
    ///      never collides with another extension's `ID` in a composing token (used only here).
    bytes32 private constant ID =
        0x09e61182b7e49969648b13fd433838b4986c1f310caae7d581425f15cdd288f5;

    /// @dev Current implemented version. v2: the royalty cap moved from a hard-coded constant to an
    ///      owner-set, reduce-only stored value (`RoyaltyStorage`), plus `reduceMaxRoyaltyBps`.
    uint16 private constant VERSION = 2;

    /// @dev The absolute ceiling the owner-chosen cap may not exceed: 100%.
    uint16 private constant ABSOLUTE_MAX_BPS = 10_000;

    error RoyaltyTooHigh();
    /// @notice The requested initial cap exceeds 100% (10000 bps).
    error RoyaltyCapAboveMax();
    /// @notice The cap is reduce-only: a new cap must be strictly below the current one.
    error RoyaltyCapNotReduced();
    /// @notice A cap may not be reduced below the royalty currently in effect — lower the royalty
    ///         first, then the cap, so reducing the cap never silently changes the live rate.
    error RoyaltyCapBelowRoyalty();

    /// @notice The current royalty ceiling (basis points). Owner-set at deploy, reduce-only after.
    function maxRoyaltyBps() public view returns (uint16) {
        return RoyaltyStorage.layout().maxRoyaltyBps;
    }

    /// @dev The live cap read used by the setters. Not `virtual` — the cap is data now, not a
    ///      per-token override point.
    function _maxRoyaltyBps() internal view returns (uint16) {
        return RoyaltyStorage.layout().maxRoyaltyBps;
    }

    /// @notice Owner updates the contract-wide default royalty (must be <= the current cap).
    function setDefaultRoyalty(address receiver, uint16 basisPoints) external onlyOwner {
        _setRoyalty(receiver, basisPoints);
    }

    /// @notice Owner lowers the royalty ceiling. Reduce-only (never raise), and never below the
    ///         royalty currently in effect. One-way by construction — the guarantee a buyer reads.
    function reduceMaxRoyaltyBps(uint16 newMaxBps) external onlyOwner {
        RoyaltyStorage.Layout storage l = RoyaltyStorage.layout();
        if (newMaxBps >= l.maxRoyaltyBps) revert RoyaltyCapNotReduced();
        if (newMaxBps < _currentRoyaltyBps()) revert RoyaltyCapBelowRoyalty();
        l.maxRoyaltyBps = newMaxBps;
        emit MaxRoyaltyBpsUpdated(newMaxBps);
    }

    /// @dev Enable the extension (announce version), set the cap, then the initial royalty. Call at
    ///      initialize. `maxBps` is the creator's chosen ceiling (<= 100%); the initial royalty is
    ///      validated against it by `_setRoyalty`.
    function _initRoyaltyExtension(address receiver, uint16 basisPoints, uint16 maxBps) internal {
        _setExtensionVersion(ID, VERSION);
        if (maxBps > ABSOLUTE_MAX_BPS) revert RoyaltyCapAboveMax();
        RoyaltyStorage.layout().maxRoyaltyBps = maxBps;
        emit MaxRoyaltyBpsUpdated(maxBps);
        _setRoyalty(receiver, basisPoints);
    }

    /// @dev The default royalty currently in effect, in basis points. ERC-2981 stores it as a fee
    ///      numerator over `_feeDenominator()` (10000 here), so `royaltyInfo(0, denom)` returns the
    ///      numerator directly — the bps. Zero when no default is set.
    function _currentRoyaltyBps() private view returns (uint16) {
        (, uint256 amount) = royaltyInfo(0, _feeDenominator());
        return uint16(amount);
    }

    /// @dev Validate, set (ERC-2981 storage), announce.
    /// @dev `basisPoints == 0` clears the royalty (receiver ignored) — the clean
    ///      "no royalty" path, since ERC-2981 forbids storing a zero receiver. A
    ///      non-zero royalty requires a non-zero receiver (ERC-2981 reverts
    ///      `RoyaltyReceiverIsZeroAddress` otherwise — a zero receiver would burn royalties).
    function _setRoyalty(address receiver, uint16 basisPoints) internal {
        if (basisPoints > _maxRoyaltyBps()) revert RoyaltyTooHigh();
        if (basisPoints == 0) {
            _deleteDefaultRoyalty();
            emit RoyaltyChangedForAll(address(0), 0); // cleared — matches royaltyInfo (0, 0)
        } else {
            _setDefaultRoyalty(receiver, uint96(basisPoints));
            emit RoyaltyChangedForAll(receiver, basisPoints);
        }
    }

    /// @notice ERC-165: the core base (165 + beacon) + ERC-2981.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbxBeaconCore, ERC2981)
        returns (bool)
    {
        return AbxBeaconCore.supportsInterface(interfaceId)
            || ERC2981.supportsInterface(interfaceId);
    }
}
