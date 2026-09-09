// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {ICreatorToken, ICreatorTokenLegacy} from "../../interfaces/ICreatorToken.sol";
import {ITransferValidator} from "./ITransferValidator.sol";
import {ITransferValidatorSetTokenType} from "./ITransferValidatorSetTokenType.sol";
import {TransferValidatorStorage} from "../../libraries/TransferValidatorStorage.sol";

/// @title CreatorToken — the ABX Creator Token (ERC-721C) extension (Register 2), as a mixin
/// @notice A token opts into ERC-721C transfer validation **at deploy, permanently**: a non-zero
///         validator in `initialize` enrolls it forever; zero leaves a plain ERC-721 forever —
///         no beacon version, no event, zero trace, indistinguishable from a pre-721C token.
///         Within an enrolled token the owner manages the validator freely: re-point it, or set
///         zero to suspend enforcement (the token *stays* enrolled). Enrollment is immutable in
///         both directions — an unenrolled token can never gain a validator, an enrolled one can
///         never shed the standard.
/// @dev The *composing token* wires `_validateTransfer` into its `_beforeTokenTransfer`. Stock
///      CreatorTokenBase semantics: mints and burns are NEVER validated (so ABX minter flows
///      can't be policy-bricked), a transfer initiated by the validator itself skips the check,
///      everything else staticcalls `validateTransfer(caller, from, to, tokenId)` on the
///      validator — a policy violation reverts and bubbles. Every non-zero validator (init or
///      re-point) must have code on this chain: a codeless "validator" silently enforcing
///      nothing is the ecosystem's nastiest footgun, so it's a revert here. ERC-165 branches on
///      enrollment by design. Storage is ERC-7201 (`TransferValidatorStorage`). Self-registers
///      its version in `_initCreatorToken` — when enrolling only.
abstract contract CreatorToken is AbxBeaconCore, Ownable, ICreatorToken {
    /// @dev keccak256("abx.extension.creator-token") — permanent extension id. `private` so it
    ///      never collides with another extension's `ID` in a composing token.
    bytes32 private constant ID =
        0x0839e7ed7fc1f5db3f253851d61b10f852045c5520c2936138b121b73e7e27c0;

    /// @dev Current implemented version (bumps when the interface or semantics change).
    uint16 private constant VERSION = 1;

    /// @dev The PermitC token-type constant for ERC-721 — the EIP number itself, the same
    ///      convention {CreatorToken1155} documents for 1155. `uint16` matches
    ///      `setTokenTypeOfCollection`'s parameter type.
    uint16 private constant TOKEN_TYPE_ERC721 = 721;

    /// @notice A non-zero transfer validator must have code on this chain.
    error InvalidTransferValidator();
    /// @notice The token wasn't enrolled at deploy; it can never become a creator token.
    error NotCreatorToken();

    /// @inheritdoc ICreatorToken
    function getTransferValidator() external view returns (address validator) {
        return TransferValidatorStorage.layout().validator;
    }

    /// @inheritdoc ICreatorToken
    /// @dev Always `validateTransfer(address,address,address,uint256)` (0xcaee23ea), a view —
    ///      the call {_validateTransfer} makes.
    function getTransferValidationFunction()
        external
        pure
        returns (bytes4 functionSignature, bool isViewFunction)
    {
        return (0xcaee23ea, true);
    }

    /// @notice Owner re-points the validator, or suspends enforcement with zero (stays enrolled).
    ///         Reverts unless the token enrolled at deploy — enrollment can never be added later.
    /// @notice **Once the collection is ownerless, anyone may suspend enforcement** (pass
    ///         `address(0)`), and that is the only thing they may do. See {_requireValidatorAuth}.
    function setTransferValidator(address validator) external {
        TransferValidatorStorage.Layout storage l = TransferValidatorStorage.layout();
        if (!l.enrolled) revert NotCreatorToken();
        _requireValidatorAuth(validator);
        _setValidator(l, validator);
        // Outside the setter, matching {CreatorToken1155-setTransferValidator}. `_setValidator`
        // returns early when the address is unchanged (so a stranger cannot spam the event on an
        // ownerless collection), and registration used to sit inside it — which meant a re-point to
        // the SAME validator could not retry a token-type registration that had failed transiently.
        // The 1155 lane already had this shape; the 721 was the outlier.
        _registerTokenType(validator);
    }

    /// @dev Authorization for a validator change, with a dead-man release.
    ///
    ///      While the collection has an owner, this is `onlyOwner` and nothing more — the owner may
    ///      re-point to any address that passes {_requireHasCode}, or pass zero to suspend.
    ///
    ///      Once `owner() == address(0)`, **anyone may suspend**. That is the release valve for the
    ///      worst state this extension can reach: a live validator that reverts every transfer, on a
    ///      collection with nobody left to re-point it, which would otherwise leave every
    ///      collector's token permanently non-transferable and unrecoverable by anyone. The
    ///      permission is deliberately asymmetric — an ownerless collection can only ever be moved
    ///      *toward* transferability, never re-armed, so this hands a stranger no power over a live
    ///      project and no way to grief one.
    ///
    ///      The trade this makes, stated plainly: "renounced **and** still enforcing forever" is no
    ///      longer a reachable configuration. A project that renounces gives up royalty enforcement
    ///      the moment any holder asks for it. That is the intended direction — an abandoned
    ///      collection's collectors keep their property, and an abandoned collection's royalties
    ///      have no one left to collect them.
    ///
    ///      It does NOT cover an owner who transfers to a dead key or an inert contract:
    ///      `owner()` is then non-zero and on chain that is indistinguishable from a cold multisig.
    ///      That residual is disclosed, not defended.
    function _requireValidatorAuth(address validator) private view {
        if (owner() == address(0)) {
            if (validator != address(0)) revert Unauthorized(); // ownerless: suspension only
            return;
        }
        _checkOwner();
        if (validator != address(0)) _requireHasCode(validator);
    }

    /// @dev Enroll as a creator token (set validator + announce version), or — when `validator`
    ///      is zero — do nothing at all: not enrolled, no beacon version, no event. Call at
    ///      initialize; nothing else ever writes `enrolled`, so the choice is permanent.
    function _initCreatorToken(address validator) internal {
        if (validator == address(0)) return;
        _requireHasCode(validator);
        TransferValidatorStorage.Layout storage l = TransferValidatorStorage.layout();
        l.enrolled = true;
        _setExtensionVersion(ID, VERSION);
        _setValidator(l, validator);
        _registerTokenType(validator); // both entry points, as on the 1155 lane
    }

    /// @dev Refuse an address that cannot actually be a validator. Two shapes silently enforce
    ///      nothing while every read surface — ERC-165, `getTransferValidator()`, the beacon
    ///      version — reports enforcement as on:
    ///        1. **no code**: a call to it succeeds trivially;
    ///        2. **a permissive fallback**: `validateTransfer` returns nothing, so there is no ABI
    ///           decode to fail, and any address whose fallback succeeds for an unknown selector
    ///           passes. The likely real-world trigger is a creator pasting their own **Safe** —
    ///           `FallbackManager.fallback()` returns empty on an unset handler — and the same is
    ///           true of an uninitialised proxy or an EIP-7702-delegated EOA.
    ///
    ///      So probe with a selector no validator implements and require it to FAIL. Every live
    ///      validator checked (OpenSea's SATSR and three Limit Break deployments, mainnet and
    ///      Sepolia) reverts here, cheaply.
    ///
    ///      **What this actually catches, stated narrowly.** Exactly one shape: a fallback that
    ///      *succeeds* for an unknown selector. A handler-less Safe singleton and an uninitialised
    ///      proxy are that shape and are rejected. But a Safe deployed through the official factory
    ///      sets `CompatibilityFallbackHandler`, which REVERTS on an unknown selector — so a normal,
    ///      correctly-configured Safe passes this probe, as do most EIP-7702-delegated EOAs
    ///      (verified against a live 6-of-3 mainnet Safe). Earlier wording here claimed Safes and
    ///      7702 EOAs were caught; they are not, in the configuration users are most likely to have.
    ///
    ///      The residual is bounded and loud rather than silent, which is why it stays a probe and
    ///      not a gate: Solidity keeps an `extcodesize` check for a no-return external call, and an
    ///      accepted non-validator also reverts on `validateTransfer`, so the collection ends up
    ///      *frozen* — visibly, and re-pointable by the owner — never quietly unenforced.
    ///
    ///      An ERC-165 probe was measured and rejected: none of those four validators advertises
    ///      `ITransferValidator` or `ITransferValidator1155` (ABX's single-function interface id is
    ///      just the selector; Limit Break's is a different XOR and SATSR is a separate codebase),
    ///      so requiring either id would reject 100% of the ecosystem — including the validator
    ///      ABX itself recommends. There is no ecosystem-wide "I am a validator" id to gate on.
    ///
    ///      **This is a misconfiguration guard, not a security boundary.** A malicious owner can
    ///      always deploy a contract that passes this probe and enforces nothing; what it catches is
    ///      the honest mistake. Output is written at `codesize()` with length 0, so no returndata is
    ///      ever copied into this frame.
    function _requireHasCode(address validator) private view {
        bool bad;
        assembly {
            mstore(0x00, 0xa9b1c2d3) // no such function on any real validator
            bad :=
                or(
                    iszero(extcodesize(validator)),
                    staticcall(gas(), validator, 0x1c, 0x04, codesize(), 0x00)
                )
        }
        if (bad) revert InvalidTransferValidator();
    }


    /// @dev Store + announce — the only writer of `validator`.
    function _setValidator(TransferValidatorStorage.Layout storage l, address validator) private {
        address old = l.validator;
        // No-change writes are a no-op, not an event. Once a collection is ownerless the suspend
        // path is permissionless, so without this a stranger can emit `TransferValidatorUpdated(0,0)`
        // without bound and make an indexer's log history for this collection unusable.
        if (old == validator) return;
        l.validator = validator;
        emit TransferValidatorUpdated(old, validator);
    }

    /// @dev Tell the validator this collection is a 721, the way stock `ERC721C` does
    ///      (`CreatorTokenBase._registerTokenType` + `ERC721C._tokenType()`). Without it a validator
    ///      treats the collection as `DEFAULT_TOKEN_TYPE = 0` and accepts ANY token type, silently
    ///      skipping the `TokenTypesDoNotMatch` check the 1155 twin gets.
    ///
    ///      This was briefly dropped to save 150 B against `SeriesCode`'s EIP-170 headroom, with the
    ///      owner able to call `setTokenTypeOfCollection` themselves as the remedy. That was the
    ///      wrong trade: on-chain standards conformance is not something to buy headroom with, and a
    ///      remedy that depends on the owner knowing to perform it is not conformance. If this ever
    ///      stops fitting, the answer is to move a body into a delegatecalled library, not to drop
    ///      it.
    ///
    ///      Best-effort, exactly as on the 1155 side: a validator that does not implement this (or
    ///      reverts) must not be able to block enrollment.
    function _registerTokenType(address validator) private {
        if (validator == address(0)) return;
        // forge-lint: disable-next-line(unchecked-call)
        try ITransferValidatorSetTokenType(validator)
            .setTokenTypeOfCollection(address(this), TOKEN_TYPE_ERC721) {}
            catch {}
    }

    /// @dev The transfer gate the composing token calls from `_beforeTokenTransfer`. Cheapest
    ///      check first: one load, so an unenrolled/suspended token pays a single sload per
    ///      transfer and never calls out.
    function _validateTransfer(address from, address to, uint256 tokenId) internal view {
        address validator = TransferValidatorStorage.layout().validator;
        if (validator == address(0)) return; // unenrolled or suspended — no enforcement
        if (from == address(0) || to == address(0)) return; // mint/burn — never validated
        if (msg.sender == validator) return; // the validator's own transfers skip the check
        ITransferValidator(validator).validateTransfer(msg.sender, from, to, tokenId);
    }

    /// @notice ERC-165: the core base (165 + beacon) + — when enrolled only — both creator-token
    ///         ids. Branching on storage is deliberate: an unenrolled token must be
    ///         indistinguishable from a pre-721C token.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbxBeaconCore)
        returns (bool)
    {
        return AbxBeaconCore.supportsInterface(interfaceId)
            || (
                (
                    interfaceId == type(ICreatorToken).interfaceId
                        || interfaceId == type(ICreatorTokenLegacy).interfaceId
                ) && TransferValidatorStorage.layout().enrolled
            );
    }
}
