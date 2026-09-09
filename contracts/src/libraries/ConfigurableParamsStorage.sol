// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {IAbxConfigurableParams} from "../extensions/configurable-params/IAbxConfigurableParams.sol";

/// @title ConfigurableParamsStorage — Configurable Params (PostParams) state, ERC-7201 namespaced
/// @notice Backing storage for the Configurable Params extension: the per-key schema registry
///         (type · auth · constraints · lock-after) and the project's three lifecycle hook
///         addresses. Values are NOT here — they live in the base Params store; this layer only
///         governs them. Reconstructable from `ParamSchemaConfigured` / `HooksConfigured` (both
///         emitted in full). Namespaced so it never collides with the ERC-721 base or mixins.
/// @notice The registry is **enumerable**: `schemaKeyList` names every declared key, so a
///         chain-only frontend can build the configure UI without an indexer — a key with a
///         schema but no value yet is otherwise undiscoverable. The list is **append-only**:
///         {AbxParamsLib} pushes on first declaration and a schema is never deleted (updating
///         one re-types it in place), so there is no removal path to get wrong. Derived state,
///         like the base store's key lists — it emits nothing of its own.
library ConfigurableParamsStorage {
    /// @notice One key's governance: what it means, who may set it, within what bounds, until when.
    struct Schema {
        bool exists; // a schema'd key is governed; without one a param is plain (owner metadata)
        IAbxConfigurableParams.ParamType paramType;
        IAbxConfigurableParams.AuthOption auth;
        address authAddress; // the `Address` leg of the auth options (zero unless used)
        uint48 lockAfter; // 0 = never locks; else writes revert after this timestamp
        bytes32 min; // range types: lower bound (encoding per type)
        bytes32 max; // range types: upper bound (0 = unbounded above for unsigned types)
        string[] selectOptions; // Select type: the enumerated choices
    }

    /// @custom:storage-location erc7201:abx.storage.configurable-params
    struct Layout {
        mapping(bytes32 key => Schema) schemas;
        address configureHook; // write-time veto/validator
        address augmentHook; // read-time derivation (consumed off-token)
        address transferHook; // ownership-change lifecycle; a VETO — its revert blocks the transfer
        address delegateRegistry; // TokenOwner-leg delegation resolver; address(0) = disabled
        bytes32[] schemaKeyList; // every declared key, in declaration order; append-only
        // One-way: once true the three hook addresses can never change again. This is what lets a
        // project turn "the hooks are whatever the owner currently says" into something a collector
        // can verify before buying — it matters most for the transferHook, which can block a
        // transfer, so an unlocked one is a standing power over a collector's ability to sell.
        bool hooksLocked;
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.configurable-params")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0x619c63008ccd1dfdbbc6f5831c7fe6e520b0fdd37ed98c8d358150a36ff55e00;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
