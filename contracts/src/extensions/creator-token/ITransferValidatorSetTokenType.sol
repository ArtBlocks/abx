// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title ITransferValidatorSetTokenType — the PermitC-flow token-type registration surface
/// @notice Limit Break's `CreatorTokenBase._registerTokenType` calls this, best-effort, on every
///         enrollment and re-point: `try ITransferValidatorSetTokenType(validator)
///         .setTokenTypeOfCollection(address(this), tokenType) {} catch {}`. It only matters for
///         Permit-C flows (letting the validator apply per-token-type policy/signature checks);
///         it is never enforcement — a validator that ignores this call still validates transfers
///         normally via `validateTransfer`.
interface ITransferValidatorSetTokenType {
    /// @notice Register `collection`'s token type with the validator (Permit-C flows only).
    function setTokenTypeOfCollection(address collection, uint16 tokenType) external;
}
