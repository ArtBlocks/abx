// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {ICreatorToken, ICreatorTokenLegacy} from "../../interfaces/ICreatorToken.sol";
import {ITransferValidator1155} from "./ITransferValidator1155.sol";
import {ITransferValidatorSetTokenType} from "./ITransferValidatorSetTokenType.sol";
import {TransferValidatorStorage} from "../../libraries/TransferValidatorStorage.sol";
import {AbxEditionLib} from "../../libraries/AbxEditionLib.sol";

/// @title CreatorToken1155 — the ABX Creator Token (ERC-1155C) extension (Register 2), as a mixin
/// @notice The ERC-1155 sibling of `CreatorToken`: identical enrollment rules (a non-zero
///         validator in `initialize` enrolls the token forever; zero leaves a plain ERC-1155
///         forever — no beacon version, no event, zero trace), identical events
///         (`TransferValidatorUpdated`) and the SAME ERC-165 ids (Limit Break's
///         creator-token-standards uses identical `ICreatorToken`/`ICreatorTokenLegacy` ids
///         across both standards), and the SAME `abx.extension.creator-token` beacon id — one
///         extension id, shared unchanged, between the 721 and 1155 families. Only the per-transfer
///         validator CALL differs: ERC-1155C's `validateTransfer` takes an `amount` and is NOT a view (vs.
///         721C's view, no-amount signature) — see `getTransferValidationFunction`.
/// @dev The *composing token* wires `_validateTransfer1155` into its `_beforeTokenTransfer`
///      override (Solady's ERC1155 hook is always batch-shaped — a single transfer arrives as a
///      1-element array). Same stock semantics as `CreatorToken`: mints and burns
///      (`from`/`to == address(0)`) are never validated; a transfer initiated by the validator
///      itself skips the check; every other transferred `(id, amount)` pair calls
///      `validateTransfer` on the validator (there is no batch validator entrypoint in the
///      ecosystem standard — a batch transfer loops, one call per id); a policy violation reverts
///      and bubbles for the whole batch. Every non-zero validator (init or re-point) must have
///      code on this chain. Storage is the SAME `TransferValidatorStorage` library `CreatorToken`
///      uses — a plain ERC-7201 layout with no ERC-721 coupling, safe to share since a given
///      token is only ever one standard (never both).
abstract contract CreatorToken1155 is AbxBeaconCore, Ownable, ICreatorToken {
    /// @dev keccak256("abx.extension.creator-token") — SAME id as `CreatorToken` (shared,
    ///      unchanged, between the 721 and 1155 families; see the class-level dev note).
    bytes32 private constant ID =
        0x0839e7ed7fc1f5db3f253851d61b10f852045c5520c2936138b121b73e7e27c0;

    /// @dev Current implemented version (bumps when the interface or semantics change).
    uint16 private constant VERSION = 1;

    /// @dev `uint256 constant TOKEN_TYPE_ERC1155 = 1155;` — verified from the limitbreak
    ///      "permit-c" npm package, version 1.0.0, file src slash Constants.sol (fetched
    ///      2026-08-05; PermitC's TOKEN_TYPE constants are literally the EIP numbers: 20/721/1155).
    ///      Cross-checked against creator-token-standards' own ERC1155C._tokenType(), which
    ///      returns uint16(TOKEN_TYPE_ERC1155) — hence uint16 here, matching
    ///      setTokenTypeOfCollection's parameter type.
    uint16 private constant TOKEN_TYPE_ERC1155 = 1155;

    /// @notice A non-zero transfer validator must have code on this chain.
    error InvalidTransferValidator();
    /// @notice The token wasn't enrolled at deploy; it can never become a creator token.
    error NotCreatorToken();

    /// @inheritdoc ICreatorToken
    function getTransferValidator() external view returns (address validator) {
        return TransferValidatorStorage.layout().validator;
    }

    /// @inheritdoc ICreatorToken
    /// @dev Always `validateTransfer(address,address,address,uint256,uint256)` (0x1854b241), NOT
    ///      a view — the call {_validateTransfer1155} makes, once per `(id, amount)` pair.
    function getTransferValidationFunction()
        external
        pure
        returns (bytes4 functionSignature, bool isViewFunction)
    {
        return (0x1854b241, false);
    }

    /// @notice Owner re-points the validator, or suspends enforcement with zero (stays enrolled).
    ///         Reverts unless the token enrolled at deploy — enrollment can never be added later.
    /// @notice **Once the collection is ownerless, anyone may suspend enforcement** (pass
    ///         `address(0)`), and that is the only thing they may do — see
    ///         {_requireValidatorCaller} for the full rationale and the trade it makes.
    /// @dev **Authorization lives HERE, in the only body there is, and this function is not
    ///      `virtual`.** Both halves of that sentence are load-bearing.
    ///
    ///      The body used to live here AND in {AbxEditionLib}, with every concrete edition token
    ///      overriding to pick the library copy — so the mixin's copy was unreachable, and three
    ///      separate fixes landed in it instead of in the code that runs. Collapsing to a delegating
    ///      body fixed that, but left this function performing no authorization at all and
    ///      {AbxEditionLib-setTransferValidator} performing none either: what actually protected the
    ///      three edition tokens was that each one *overrode* this to call the caller check first.
    ///      One guard, three copies, in front of an unguarded mixin — so a fourth edition type that
    ///      simply inherited would have shipped an unauthenticated `setTransferValidator`, which
    ///      decides whether collectors' tokens can move at all.
    ///
    ///      Now the guard runs before the delegation, the tokens carry no override, and `virtual` is
    ///      gone so none can be added without deleting this word first. `ValidatorAuthInvariants.t.sol`
    ///      asserts the rule on all six token types, so a regression fails the build rather than
    ///      waiting for a reader to notice.
    function setTransferValidator(address validator) external {
        // The caller check must stay in the mixin: {AbxEditionLib} cannot reach `Ownable`'s
        // internals. The library does the rest (enrollment + the validator code probe).
        _requireValidatorCaller(validator);
        AbxEditionLib.setTransferValidator(validator);
    }

    /// @dev The dead-man release: `onlyOwner` while an owner exists, permissionless *suspend* once
    ///      the collection is ownerless, so an abandoned collection can never leave collectors'
    ///      tokens frozen behind a validator nobody can re-point. Asymmetric by design — an
    ///      ownerless collection can only move toward transferability, never be re-armed. The caller
    ///      half only: the non-zero-validator code probe runs inside
    ///      {AbxEditionLib-setTransferValidator}, so duplicating it here would cost {EditionCode}
    ///      ~150 B it does not have. See {CreatorToken-_requireValidatorAuth} for the full note.
    function _requireValidatorCaller(address validator) private view {
        if (owner() == address(0)) {
            if (validator != address(0)) revert Unauthorized(); // ownerless: suspension only
            return;
        }
        _checkOwner();
    }

    /// @dev Enroll as a creator token, or — when `validator` is zero — do nothing at all: not
    ///      enrolled, no beacon version, no event. Call at initialize; nothing else ever writes
    ///      `enrolled`, so the choice is permanent.
    ///
    ///      **One body, in {AbxEditionLib}, and NOT `virtual`.** The enrollment logic used to live
    ///      here as well, with all three edition tokens overriding to reach the library — so this
    ///      mixin's copy was dead, and so were the three private helpers it was the only caller of
    ///      (`_requireHasCode`, `_setValidator`, `_registerTokenType`). All four are gone. The
    ///      library writes `BeaconStorage` directly because it cannot reach a mixin's `private`
    ///      `_setExtensionVersion`, which is also why {AbxEditionLib} restates the extension id and
    ///      version as literals — see the paired comment there before changing either.
    function _initCreatorToken(address validator) internal {
        AbxEditionLib.initCreatorToken(validator);
    }

    /// @dev The transfer gate the composing token calls from its `_beforeTokenTransfer` override,
    ///      once per batch (loops `ids`/`amounts` itself — Solady's hook is always batch-shaped,
    ///      a single op arrives as a 1-element array). Cheapest check first: one load, so an
    ///      unenrolled/suspended token pays a single sload per batch and never calls out.
    function _validateTransfer1155(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts
    ) internal virtual {
        // ONE implementation — see {Uri1155-setTokenURIBase} for why the mixin no longer keeps a
        // copy of a body the concrete tokens all delegate past.
        AbxEditionLib.validateTransfer1155(from, to, ids, amounts);
    }

    /// @notice ERC-165: the core base (165 + beacon) + — when enrolled only — both creator-token
    ///         ids (identical ids to `CreatorToken` — Limit Break shares them across standards).
    ///         Branching on storage is deliberate: an unenrolled token must be indistinguishable
    ///         from a pre-1155C token.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbxBeaconCore)
        returns (bool)
    {
        return AbxBeaconCore.supportsInterface(interfaceId)
            || ((interfaceId == type(ICreatorToken).interfaceId
                    || interfaceId == type(ICreatorTokenLegacy).interfaceId)
                && TransferValidatorStorage.layout().enrolled);
    }
}
