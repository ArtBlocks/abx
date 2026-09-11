// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {ParamsStorage} from "./ParamsStorage.sol";
import {ConfigurableParamsStorage} from "./ConfigurableParamsStorage.sol";
import {IAbxConfigurableParams} from
    "../extensions/configurable-params/IAbxConfigurableParams.sol";
import {IAbxConfigureHook} from "../extensions/configurable-params/IAbxParamHooks.sol";
import {IDelegateRegistry} from "../interfaces/IDelegateRegistry.sol";

/// @title AbxParamsLib — the Params + Configurable Params write paths and the key-enumeration
///        + schema reads, as an EXTERNAL library
/// @notice Deployed once per chain and `delegatecall`ed by every ABX token that composes the
///         Params extensions — the same shared-singleton trust model as the renderer and chunk
///         store, applied to code size: the schema validation, auth dispatch, chunk staging,
///         event encoding, and enumeration/schema reads live here ONCE instead of in every
///         token implementation (EIP-170 is the forcing function). Because library calls are
///         delegatecalls, all storage writes hit the token's own ERC-7201 namespaces and all
///         events log **from the token address** — the spine is byte-identical to an inlined
///         implementation.
/// @dev `msg.sender` inside these functions is the token's original caller (delegatecall
///      preserves it), so schema auth reads it directly; the `creator` (the token's `owner()`)
///      is passed in by the mixin. Access control stays in the mixins (`onlyOwner`, the
///      `_checkParamWrite` guard chain) — this library assumes its caller already gated.
///      Event declarations here duplicate the extension interfaces' — same signatures, same
///      topics; Solidity requires local declarations to emit.
/// @dev **The key lists are maintained here, and only here.** These four functions
///      (`setTokenParam` / `setContractParam` / `clearTokenParam` / `clearContractParam`) are
///      the choke points every write funnels through — raw owner setters, the data variants,
///      the governed `configureTokenParam*` path, mint-time seeds, hook-driven writes — so no
///      caller can forget to keep `ParamsStorage`'s enumeration in step with the map. Measured
///      cost on top of the value write: **~+45k gas** the first time a key is set (its list
///      element and its index-mapping slot, both zero→nonzero), or **~+67k for the first key in
///      a scope**, which also initializes the list-length slot. Re-setting a listed key adds
///      ~400 gas (one warm index read); clearing adds ~1–2k (the swap-and-pop). A seeded mint
///      pays ~40 — `seed` is never indexed. Key count is uncapped by design: the binding limit
///      is the read side (each enumerated param costs the generator/renderer guarded staticcalls
///      plus a decode inside one `eth_call`), documented as a design envelope in the params
///      spec, not enforced here.
library AbxParamsLib {
    /// @dev The reserved mint-time randomness key. **Never indexed, at either scope:** it is a
    ///      tokenData coordinate every consumer reads directly and skips while enumerating, so
    ///      listing it would charge every seeded mint the first-write cost above for nothing.
    ///      Its clear path needs no special case — `index == 0` already no-ops (see `_unindex`).
    bytes32 private constant SEED_KEY = "seed";

    // ── event mirrors (identical signatures ⇒ identical topics) ────────────────
    event ContractParamConfigured(
        bytes32 indexed key, bytes32 value, bool valueIsHash, address indexed updatedBy
    );
    event TokenParamConfigured(
        uint256 indexed tokenId,
        bytes32 indexed key,
        bytes32 value,
        bool valueIsHash,
        address indexed updatedBy
    );
    event ContractParamCleared(bytes32 indexed key, address indexed updatedBy);
    event TokenParamCleared(uint256 indexed tokenId, bytes32 indexed key, address indexed updatedBy);
    event ParamSchemaConfigured(
        bytes32 indexed key,
        IAbxConfigurableParams.ParamType paramType,
        IAbxConfigurableParams.AuthOption auth,
        address authAddress,
        uint48 lockAfter,
        bytes32 min,
        bytes32 max,
        string[] selectOptions
    );
    event HooksConfigured(address configureHook, address augmentHook, address transferHook);
    event ParamHooksFrozen();
    event DelegateRegistrySet(address indexed registry);
    event MetadataUpdate(uint256 _tokenId); // ERC-4906
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId); // ERC-4906

    error ParamNotSet();
    error EmptyParamValue();
    error NoParamSchema();
    error NotParamAuthorized();
    error ParamLockExpired();
    /// @notice A param's `lockAfter` deadline may only be brought FORWARD, never pushed back and
    ///         never cleared. Retiring a param is meant to be permanent; a re-openable lock is not
    ///         a lock.
    error ParamLockNotExtendable();
    error InvalidParamValue();
    error InvalidParamSchema();
    error WrongValuePath();
    /// @notice A param key must be readable ASCII with only trailing zero padding. A key carrying an
    ///         INTERIOR zero renders as its truncated prefix (`keyToString` stops at the first zero)
    ///         while comparing unequal as a 32-byte word — so `"seed\0<junk>"` slipped past every
    ///         reserved-key guard and then serialized as `"seed"`.
    error InvalidParamKey();
    /// @notice The hook set is frozen — `setParamHooks` is closed forever on this collection.
    error ParamHooksLocked();
    /// @notice `seed` is assigned and settled — no path may rewrite or clear it, and it is never
    ///         data-backed. Declared here because this library is the single choke point every
    ///         external write passes through; the composing tokens re-declare it for their ABI,
    ///         and the selector is identical either way.
    error SeedSettled();
    /// @notice The caller is not the token owner. Mirrors Solady `Ownable.Unauthorized()` (same
    ///         selector 0x82b42900), so the extracted owner-gated write path is byte-indistinguishable
    ///         from the former `onlyOwner` mixin shell to every caller, indexer, and test.
    error Unauthorized();
    /// @notice The key has a schema, so it is governed: raw owner setters are closed for it and the
    ///         write must go through `configureTokenParam*`. Mirrors {ConfigurableParams} (same
    ///         selector) — the former `_checkParamWrite` guard, now enforced here at the choke point.
    error SchemaGoverned();

    /// @dev Solady `Ownable`'s owner storage slot. Under delegatecall `address(this)` is the token,
    ///      so `sload(OWNER_SLOT)` reads the token owner — the extracted equivalent of `onlyOwner`.
    ///      Read the same way Solady's own `owner()` reads it.
    bytes32 private constant OWNER_SLOT =
        0xffffffffffffffffffffffffffffffffffffffffffffffffffffffff74873927;

    function _owner() private view returns (address o) {
        assembly {
            o := sload(OWNER_SLOT)
        }
    }

    /// @dev The extracted `onlyOwner`. The Params/ConfigurableParams WRITE shells moved
    ///      into this library as raw-calldata passthroughs (the reads were already passthroughs), so
    ///      the gate that lived on each `external onlyOwner` mixin function is enforced here instead.
    function _requireOwner() private view {
        if (msg.sender != _owner()) revert Unauthorized();
    }

    /// @dev The extracted `_checkParamWrite`: a schema'd key is governed, so a raw owner write is
    ///      refused (its value moves only through `configureTokenParam*`). Both code tokens that
    ///      compose these params also compose `ConfigurableParams`, so this schema check is always
    ///      the active guard — exactly as the overridden mixin `_checkParamWrite` was.
    function _requireUngoverned(bytes32 key) private view {
        if (ConfigurableParamsStorage.layout().schemas[key].exists) revert SchemaGoverned();
    }

    // ── owner-gated write front doors (the extracted mixin shells) ─────────────────────────────
    //
    // Each MATCHES a token's external ABI selector exactly, so the mixin forwards raw calldata here
    // (identical mechanism to the read passthroughs). They gate — owner, plus schema-governance
    // where the shell did — then delegate to the internal write body of the same name below.
    // `msg.sender` is the original external caller (delegatecall preserves it); the owner is read
    // from storage. The bodies these call (the 4-/5-arg overloads, and `configureTokenParam*`'s
    // `creator` form) stay as the privileged internal write path — reachable from mint-time/hook
    // writers and from these front doors, never routed to from a token's external ABI.

    function setTokenParam(uint256 tokenId, bytes32 key, bytes32 value) public {
        _requireOwner();
        _requireUngoverned(key);
        setTokenParam(tokenId, key, value, false, msg.sender);
    }

    function setTokenParamData(uint256 tokenId, bytes32 key, bytes calldata data) public {
        _requireOwner();
        _requireUngoverned(key);
        setTokenParamData(tokenId, key, data, msg.sender);
    }

    function clearTokenParam(uint256 tokenId, bytes32 key) public {
        _requireOwner();
        _requireUngoverned(key);
        clearTokenParam(tokenId, key, msg.sender);
    }

    function setContractParam(bytes32 key, bytes32 value) public {
        _requireOwner();
        _requireUngoverned(key);
        setContractParam(key, value, false, msg.sender);
    }

    function setContractParamData(bytes32 key, bytes calldata data) public {
        _requireOwner();
        _requireUngoverned(key);
        setContractParamData(key, data, msg.sender);
    }

    /// @dev NO governance check, matching the mixin's documented exception: a governed key whose
    ///      contract-scope default is stuck must stay clearable (clearing removes a fallback; it
    ///      cannot forge a value or bypass a schema's auth on any token-scope write).
    function clearContractParam(bytes32 key) public {
        _requireOwner();
        clearContractParam(key, msg.sender);
    }

    /// @dev NOT owner-gated — governed by the key's schema auth, checked in the `creator` body. The
    ///      owner is read here and passed as `creator`, exactly as the mixin passed `owner()`.
    function configureTokenParam(uint256 tokenId, bytes32 key, bytes32 value) public {
        configureTokenParam(tokenId, key, value, _owner());
    }

    function configureTokenParamData(uint256 tokenId, bytes32 key, bytes calldata data) public {
        configureTokenParamData(tokenId, key, data, _owner());
    }

    /// @dev Reject a key with an interior zero byte. This is the class fix for a bypass that three
    ///      separate reviews found independently: every reserved-key guard in this library and in
    ///      {TokenDataLib} compares a full `bytes32`, but a consumer only ever sees
    ///      `keyToString(key)`, which stops at the first zero. So `bytes32("seed\0x")` is not
    ///      `SEED_KEY` — it passes the settled-seed rule, the schema rule, and the coordinate filter
    ///      — and then renders as the JSON member `"seed"`, appended last, which a last-wins parser
    ///      prefers over the real coordinate. Guarding each comparison would have to be repeated at
    ///      every future one; rejecting the malformed shape at the write choke points closes all of
    ///      them at once, and aligns with the off-chain decoder, which already refuses these keys.
    function _requireCanonicalKey(bytes32 key) private pure {
        if (key == bytes32(0)) revert InvalidParamKey(); // an empty key has no readable name
        bool seenZero;
        for (uint256 i; i < 32; ++i) {
            bytes1 c = key[i];
            if (c == 0) {
                seenZero = true;
            } else if (seenZero) {
                revert InvalidParamKey(); // interior NUL: two keys would render the same name
            } else if (c < 0x20 || c > 0x7E) {
                // The other half of the "readable ASCII" rule this error has always promised, and
                // the unswept sibling of the renderer's `_repName` fix. A key is rendered into JSON
                // through `escapeJSON`, which is byte-level and passes >= 0x80 through verbatim — so
                // one contract-scope write with a high byte makes EVERY `tokenURI` in the collection
                // invalid UTF-8, rejected outright by strict decoders. Once a schema is attached to
                // such a key there is no clean way back, so it has to be refused at the door.
                revert InvalidParamKey();
            }
        }
    }

    /// @notice Close the seed's governance model BEFORE an unset seed is drawn.
    /// @dev The pre-sale commitment is that `paramSchema("seed")` tells a buyer, before the sale,
    ///      whether the creator can rewrite a seed. `setParamSchema` enforces it by refusing the
    ///      `seed` key once `anySeedAssigned` is set — but that bit was only set when the seed
    ///      PERSISTED, which is after the external seed-source call returns.
    ///
    ///      Adversarial review showed what that window buys: a custom seed source that is also
    ///      the project owner reenters `setParamSchema("seed", ..., Creator, ...)` from inside
    ///      `seed()`, and the outer frame then persists the drawn seed under a schema that did not
    ///      exist when a buyer checked. The collection reads as ungoverned right up to its first
    ///      mint and ends that mint creator-rewriteable.
    ///
    ///      Latching first closes it: a reentrant declaration now reverts `SeedSettled`, and if the
    ///      source reverts the whole transaction — latch included — unwinds. The later persist sets
    ///      the same bit again, idempotently.
    function latchSeedAssignment() public {
        ParamsStorage.layout().anySeedAssigned = true;
    }

    // ── base params: writes ─────────────────────────────────────────────────--

    function setTokenParam(
        uint256 tokenId,
        bytes32 key,
        bytes32 value,
        bool valueIsHash,
        address updatedBy
    ) public {
        _requireCanonicalKey(key);
        ParamsStorage.Layout storage l = ParamsStorage.layout();
        // The settled-seed promise, enforced structurally at the one choke point every external
        // write funnels through — the owner's raw setter, the governed `configureTokenParam*`
        // path, and a seed source re-entering mid-mint all land here.
        //
        // A settled seed is final UNLESS the project declared a `seed` schema, which is the
        // opt-in reassignable-seed feature (typically `AuthOption.TokenOwner`; the value is supplied
        // by the caller, so this is a pick, not a fresh draw — nothing re-invokes the seed source).
        // On a 721 that reads as "the token's owner re-picks their own seed"; on an ERC-1155 EDITION
        // the seed is shared per id and `TokenOwner` means ANY holder, so it reads as "any holder
        // re-picks the seed for all co-holders of the work" — a materially different, edition-specific
        // consequence the CLI warns about at schema-declaration time. That exemption is safe
        // only because a `seed` schema cannot be
        // declared once any seed exists (see {setParamSchema}), so the choice is a pre-sale
        // commitment a buyer can read rather than something retrofitted after the money moved.
        if (key == SEED_KEY) {
            if (l.tokenParams[tokenId][key].isSet && !hasSchema(SEED_KEY)) revert SeedSettled();
            l.anySeedAssigned = true; // freezes the seed's governance model from here on
        }
        if (!valueIsHash && l.tokenData[tokenId][key] != address(0)) {
            delete l.tokenData[tokenId][key]; // a literal replaces a data-backed value
        }
        l.tokenParams[tokenId][key] = ParamsStorage.Param(value, valueIsHash, true);
        // `_index` skips `seed` itself; short-circuiting here as well keeps a seeded mint from
        // even deriving the two per-token storage pointers it would then throw away.
        if (key != SEED_KEY) {
            _index(l.tokenParamKeyList[tokenId], l.tokenParamKeyIndex[tokenId], key);
        }
        emit TokenParamConfigured(tokenId, key, value, valueIsHash, updatedBy);
        emit MetadataUpdate(tokenId);
    }

    function setTokenParamData(uint256 tokenId, bytes32 key, bytes calldata data, address updatedBy)
        public
    {
        if (data.length == 0) revert EmptyParamValue();
        _requireBlobbableKey(key);
        _persistTokenBlob(tokenId, key, SSTORE2.write(data), keccak256(data), updatedBy);
    }

    /// @dev A seed is a 32-byte literal, never a blob: a data-backed `seed` would publish the content
    ///      *hash* as the seed and split one token into two works depending on which surface read it.
    ///      Refuse the shape outright rather than define that away. Shared by both blob paths and
    ///      checked BEFORE either writes, so a doomed write never pays ~200 gas/byte first.
    function _requireBlobbableKey(bytes32 key) private pure {
        if (key == SEED_KEY) revert SeedSettled();
    }

    /// @dev Store an ALREADY-WRITTEN blob pointer and its hash. Factored out because two paths reach
    ///      it — the owner's raw {setTokenParamData} and the governed {configureTokenParamData}, which
    ///      must write the blob BEFORE its hook runs so the hook can read it. Keeping ONE body is not
    ///      stylistic here: this repo has produced three separate bugs from a body existing in two
    ///      places, with the fix landing in the copy that does not run.
    function _persistTokenBlob(
        uint256 tokenId,
        bytes32 key,
        address blob,
        bytes32 hash,
        address updatedBy
    ) private {
        ParamsStorage.layout().tokenData[tokenId][key] = blob;
        setTokenParam(tokenId, key, hash, true, updatedBy);
    }

    function clearTokenParam(uint256 tokenId, bytes32 key, address updatedBy) public {
        ParamsStorage.Layout storage l = ParamsStorage.layout();
        if (!l.tokenParams[tokenId][key].isSet) revert ParamNotSet();
        if (key == SEED_KEY) revert SeedSettled(); // settled means settled — clearing is a rewrite
        delete l.tokenParams[tokenId][key];
        delete l.tokenData[tokenId][key]; // abandoned SSTORE2 pointers are inert
        _unindex(l.tokenParamKeyList[tokenId], l.tokenParamKeyIndex[tokenId], key);
        emit TokenParamCleared(tokenId, key, updatedBy);
        emit MetadataUpdate(tokenId);
    }

    function setContractParam(bytes32 key, bytes32 value, bool valueIsHash, address updatedBy)
        public
    {
        _requireCanonicalKey(key);
        ParamsStorage.Layout storage l = ParamsStorage.layout();
        if (!valueIsHash && l.contractData[key] != address(0)) {
            delete l.contractData[key]; // a literal replaces a data-backed value
        }
        l.contractParams[key] = ParamsStorage.Param(value, valueIsHash, true);
        _index(l.contractParamKeyList, l.contractParamKeyIndex, key);
        emit ContractParamConfigured(key, value, valueIsHash, updatedBy);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function setContractParamData(bytes32 key, bytes calldata data, address updatedBy) public {
        if (data.length == 0) revert EmptyParamValue();
        ParamsStorage.layout().contractData[key] = SSTORE2.write(data);
        setContractParam(key, keccak256(data), true, updatedBy);
    }

    function clearContractParam(bytes32 key, address updatedBy) public {
        ParamsStorage.Layout storage l = ParamsStorage.layout();
        if (!l.contractParams[key].isSet) revert ParamNotSet();
        delete l.contractParams[key];
        delete l.contractData[key];
        _unindex(l.contractParamKeyList, l.contractParamKeyIndex, key);
        emit ContractParamCleared(key, updatedBy);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    // ── configurable params: schema + hooks + the governed write path ────────--

    function setParamSchema(
        bytes32 key,
        IAbxConfigurableParams.ParamType paramType,
        IAbxConfigurableParams.AuthOption auth,
        address authAddress,
        uint48 lockAfter,
        bytes32 min,
        bytes32 max,
        string[] calldata selectOptions
    ) public {
        // No `_requireOwner()` here: this is the one write path still reached by a TYPED mixin call
        // (its enum params give it a library-specific selector a raw passthrough can't match — see
        // {ConfigurableParams-setParamSchema}), and that mixin shell keeps its `onlyOwner` gate.
        _requireCanonicalKey(key);
        if (key == SEED_KEY) {
            // The seed's governance model is a pre-sale commitment: whether a seed can be reassigned,
            // and by whom, must be declared before any seed exists, so a buyer can read it and
            // price it. Once the first seeded mint lands, this key is closed — declaring or
            // re-pointing a `seed` schema afterwards would change what a collector already bought.
            if (ParamsStorage.layout().anySeedAssigned) revert SeedSettled();
            // A `String`/`Bytes` seed schema is unusable: those types write through the data path,
            // and a seed is never data-backed, so both write paths would refuse it. Reject it at
            // declaration instead of accepting a schema that can never be used — and note this is
            // the only chance to catch it, since the rule above closes the key after the first mint.
            if (
                paramType == IAbxConfigurableParams.ParamType.String
                    || paramType == IAbxConfigurableParams.ParamType.Bytes
            ) revert InvalidParamSchema();
        } else if (
            key == "chainId" || key == "contractAddress" || key == "tokenId"
        ) {
            // The other three tokenData coordinates. Both renderers skip them when emitting params,
            // so a schema here produces values that are silently dropped at read — paid for, then
            // ignored. The specs already claimed tooling rejects this; now the contract does, which
            // is the only place it cannot be bypassed.
            revert InvalidParamSchema();
        }
        // structural validation — a schema any frontend can trust to build UI from
        if (paramType == IAbxConfigurableParams.ParamType.Select) {
            if (selectOptions.length == 0) revert InvalidParamSchema();
        } else if (selectOptions.length != 0) {
            revert InvalidParamSchema();
        }
        if (paramType == IAbxConfigurableParams.ParamType.Int256Range) {
            if (int256(uint256(min)) > int256(uint256(max))) revert InvalidParamSchema();
        } else if (uint256(max) != 0 && uint256(min) > uint256(max)) {
            revert InvalidParamSchema();
        }
        bool usesAddress = auth == IAbxConfigurableParams.AuthOption.Address
            || auth == IAbxConfigurableParams.AuthOption.CreatorOrAddress
            || auth == IAbxConfigurableParams.AuthOption.TokenOwnerOrAddress
            || auth == IAbxConfigurableParams.AuthOption.CreatorOrTokenOwnerOrAddress;
        if (usesAddress != (authAddress != address(0))) revert InvalidParamSchema();

        ConfigurableParamsStorage.Layout storage cl = ConfigurableParamsStorage.layout();
        ConfigurableParamsStorage.Schema storage s = cl.schemas[key];
        // A bitten lock welds the SCHEMA too, not just the value. Otherwise `lockAfter` is a much
        // weaker promise than it reads as: a locked `Select` param's option table could be swapped
        // afterwards, so the value a collector bought — index 3, "Ember" — renders as "Frost"
        // without any param write at all. Re-typing, re-authing or re-bounding a locked param is
        // the same class of rewrite, so the whole schema freezes together.
        //
        // Checked here, before the first field is assigned. A revert would unwind those writes
        // anyway, but a guard that runs after the effects it guards is one refactor away from
        // being wrong, and `s.lockAfter` must be read while it still holds the OLD deadline.
        if (s.lockAfter != 0 && block.timestamp > s.lockAfter) revert ParamLockExpired();
        if (!s.exists) {
            // first declaration → enumerable. Append-only: updating a schema re-types it in
            // place and a schema is never deleted, so the list never needs a removal path.
            cl.schemaKeyList.push(key);
            s.exists = true;
        }
        s.paramType = paramType;
        s.auth = auth;
        s.authAddress = authAddress;
        // `lockAfter` is MONOTONIC: it may only ever move earlier, never later, and never back to
        // "no lock" (`0`). Without this it was written unconditionally, so "retiring" a param —
        // which the CLI, its confirmation prompt, and nine doc surfaces all describe as permanent,
        // irreversible, no way back — took exactly one call to undo. `lock-field`'s own refusal
        // prescribes `:lock=now` as the way to *weld* a param, which only means something if the
        // weld holds. A deadline a project can push back is a deadline collectors cannot price.
        if (s.lockAfter != 0 && (lockAfter == 0 || lockAfter > s.lockAfter)) {
            revert ParamLockNotExtendable();
        }
        s.lockAfter = lockAfter;
        s.min = min;
        s.max = max;
        delete s.selectOptions;
        for (uint256 i; i < selectOptions.length; ++i) {
            s.selectOptions.push(selectOptions[i]);
        }

        emit ParamSchemaConfigured(
            key, paramType, auth, authAddress, lockAfter, min, max, selectOptions
        );
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    /// @dev Owner-only, with **no dead-man release** — deliberately, and unlike
    ///      {CreatorToken-_requireValidatorAuth}, which has one.
    ///
    ///      A release valve was written here and then removed. Its reasoning: a reverting transfer
    ///      hook on an ownerless collection freezes every collector's token and all issuance with
    ///      nobody left to re-point it, so let anyone disarm the hook once `owner() == address(0)`.
    ///      That reasoning mistakes what a transfer hook IS. A transfer validator is a third party's
    ///      policy contract, purely restrictive, so disarming it can only ever permit more. A param
    ///      transfer hook is the CREATOR'S OWN contract and is frequently load-bearing — work
    ///      that responds to its owner, provenance the render reads. Letting a stranger switch it
    ///      off is not a safety valve; it is a new way to break a project that was working, and it
    ///      would fire on exactly the collections that were most finished (ownerless = settled).
    ///
    ///      So this is a trust assumption, stated rather than engineered around: a creator can wire
    ///      a hook that bricks their own collection, and renouncing afterwards makes it permanent.
    ///      They are not incentivised to — it destroys the thing they were paid for — and the same
    ///      creator has many blunter ways to ruin their own project. `paramHooks()` and
    ///      `paramHooksLocked()` are the reads that let a buyer price that risk before buying.
    function setParamHooks(address configureHook, address augmentHook, address transferHook)
        public
    {
        _requireOwner();
        ConfigurableParamsStorage.Layout storage l = ConfigurableParamsStorage.layout();
        if (l.hooksLocked) revert ParamHooksLocked();
        l.configureHook = configureHook;
        l.augmentHook = augmentHook;
        l.transferHook = transferHook;
        emit HooksConfigured(configureHook, augmentHook, transferHook);
    }

    /// @dev Freeze the hook set forever. One-way by design: the point is to be un-take-backable, so
    ///      a buyer reading `paramHooks()` plus this flag knows exactly which contracts can ever run
    ///      on their token — including which one can refuse their transfer.
    /// @dev **This freezes ADDRESSES, not behavior.** A hook is a contract, and a contract can be a
    ///      proxy. A creator may lock a proxy as the transfer hook, renounce ownership, and later
    ///      upgrade that proxy to revert — permanently freezing transfers while `paramHooksLocked()`
    ///      still reads true. The same pointer/code distinction applies to renderers and readers.
    ///
    ///      Detecting proxies on chain is complex and incomplete, so the protocol does not try:
    ///      locks are defined as pointer locks and the limit is disclosed. A project that wants
    ///      permanence deploys immutable hooks; verification tooling is where "this points at
    ///      known-upgradeable code" belongs, because that check needs off-chain knowledge.
    function lockParamHooks() public {
        _requireOwner();
        ConfigurableParamsStorage.layout().hooksLocked = true;
        emit ParamHooksFrozen();
    }

    /// @dev The governed literal write. `creator` = the token's `owner()`; `msg.sender` is the
    ///      original external caller (delegatecall preserves it).
    function configureTokenParam(uint256 tokenId, bytes32 key, bytes32 value, address creator)
        public
    {
        ConfigurableParamsStorage.Schema storage s = _requireConfigurable(tokenId, key, creator);
        if (
            s.paramType == IAbxConfigurableParams.ParamType.String
                || s.paramType == IAbxConfigurableParams.ParamType.Bytes
        ) revert WrongValuePath();
        _validateLiteral(s, value);
        // Scalar path: the whole value fits in `value`, so the blob arguments are zero. `dataLength`
        // is the discriminator a hook reads — and it can never be 0 on the blob path (an empty value
        // is refused there), so zero here is unambiguous rather than merely conventional.
        _runConfigureHook(tokenId, key, value, 0, address(0));
        setTokenParam(tokenId, key, value, false, msg.sender);
    }

    /// @dev The governed data write (`String`/`Bytes`): one blob, hash as the evented value.
    function configureTokenParamData(
        uint256 tokenId,
        bytes32 key,
        bytes calldata data,
        address creator
    ) public {
        ConfigurableParamsStorage.Schema storage s = _requireConfigurable(tokenId, key, creator);
        if (
            s.paramType != IAbxConfigurableParams.ParamType.String
                && s.paramType != IAbxConfigurableParams.ParamType.Bytes
        ) revert WrongValuePath();
        if (data.length == 0) revert InvalidParamValue();
        // A `String` value is the ONE byte source in this protocol that a non-owner writes and that
        // lands in the rendered document. Everything else raw is owner-controlled, where "the owner
        // can already ruin their own project" answers it — that argument does not reach here.
        //
        // `escapeJSON` escapes quotes, backslashes and control bytes, so a value cannot break out of
        // its slot. What it does NOT do is validate UTF-8: bytes >= 0x80 pass through verbatim. So a
        // single malformed sequence makes the WHOLE `tokenURI` undecodable to a strict parser —
        // name, image, provenance, all of it. On an ERC-1155 edition that is worse than it sounds:
        // `TokenOwner` means any holder of the id and params are shared state, so one holder of one
        // copy can do this to every other holder of the same work, permanently if a `lockAfter`
        // then bites.
        //
        // This codebase has already refused exactly this failure mode twice — for param keys
        // ({_requireCanonicalKey}) and for representation tags (the renderer's `_repName`) — both
        // times where the owner was the one causing it. Refusing it here too, at the write, keeps
        // the read path's "never reverts" property intact.
        if (s.paramType == IAbxConfigurableParams.ParamType.String && !_isValidUtf8(data)) {
            revert InvalidParamValue();
        }
        _requireBlobbableKey(key);
        // WRITE BEFORE THE HOOK, deliberately. The hook receives the blob's address so it can inspect
        // content without the bytes being copied into every configure call — and an address is only
        // meaningful once the contract behind it exists. Handing over a not-yet-written pointer would
        // be actively dangerous rather than merely useless: `SSTORE2.read` computes its length as
        // `extcodesize(pointer) - 1`, which on an empty account underflows to a masked huge value.
        //
        // The cost of this ordering is that a VETOED write has already paid for the blob. On the
        // accepted path nothing changes (the blob is written exactly once either way), the waste falls
        // on the rejected writer's own gas, and `eth_call` surfaces the rejection for free first. That
        // is the trade for letting a hook see what it is approving.
        address blob = SSTORE2.write(data);
        bytes32 hash = keccak256(data);
        _runConfigureHook(tokenId, key, hash, data.length, blob);
        _persistTokenBlob(tokenId, key, blob, hash, msg.sender);
    }

    /// @dev Well-formed UTF-8 per RFC 3629, the subset JSON permits: no overlong encodings, no
    ///      surrogate halves (U+D800..U+DFFF), nothing above U+10FFFF, every continuation byte
    ///      present and in range. Rejecting is enough — no transcoding, no allocation, one pass.
    function _isValidUtf8(bytes calldata b) private pure returns (bool) {
        uint256 i;
        uint256 n = b.length;
        while (i < n) {
            uint8 c = uint8(b[i]);
            uint256 len;
            uint256 lo; // lowest code point this length may legally encode (overlong check)
            if (c < 0x80) {
                i += 1;
                continue;
            } else if (c >= 0xC2 && c <= 0xDF) {
                len = 2;
                lo = 0x80;
            } else if (c >= 0xE0 && c <= 0xEF) {
                len = 3;
                lo = 0x800;
            } else if (c >= 0xF0 && c <= 0xF4) {
                len = 4;
                lo = 0x10000;
            } else {
                return false; // 0x80..0xC1 (continuation or overlong lead) and 0xF5..0xFF
            }
            if (i + len > n) return false;
            uint256 cp = uint256(c & (0xFF >> (len + 1)));
            for (uint256 k = 1; k < len; ++k) {
                uint8 cc = uint8(b[i + k]);
                if (cc < 0x80 || cc > 0xBF) return false;
                cp = (cp << 6) | (cc & 0x3F);
            }
            if (cp < lo) return false; // overlong
            if (cp >= 0xD800 && cp <= 0xDFFF) return false; // UTF-16 surrogate half
            if (cp > 0x10FFFF) return false;
            i += len;
        }
        return true;
    }

    /// @dev The TokenOwner-leg delegation resolver (see `_isAuthorized`). Zero disables.
    ///      Owner-gated front door for the external passthrough.
    function setDelegateRegistry(address registry) public {
        _requireOwner();
        initDelegateRegistry(registry);
    }

    /// @dev Auth-free registry write for the INIT path only: during `initialize` `msg.sender` is the
    ///      factory, not the owner, so an owner gate would refuse it. Not routed to from any token's
    ///      external ABI (no external shell forwards this selector), so it is unreachable post-deploy.
    function initDelegateRegistry(address registry) public {
        ConfigurableParamsStorage.layout().delegateRegistry = registry;
        emit DelegateRegistrySet(registry);
    }

    // ── reads: key enumeration + schema ─────────────────────────────────────--
    // The `IAbxParams` key-enumeration views and the `IAbxConfigurableParams` schema views,
    // externalized from the mixins for the same EIP-170 reason as the writes. Pure reads over the
    // token's namespaces; the extra delegatecall hop
    // rides the eth_call lane, never the gas-metered hot path.
    //
    // **Signatures and return types here are the mixins' external ABI, verbatim.** The mixin
    // shells delegatecall this library with their raw calldata (same signature ⇒ same selector)
    // and return the raw return data — decoding + re-encoding dynamic returns at the call site
    // costs more bytes than the bodies ever saved — so any drift here is a silent ABI break on
    // every token. Change these only in lockstep with `IAbxParams`/`IAbxConfigurableParams`.

    function tokenParamKeys(uint256 tokenId) public view returns (bytes32[] memory keys) {
        (keys,) =
            _pageKeys(ParamsStorage.layout().tokenParamKeyList[tokenId], 0, type(uint256).max);
    }

    function tokenParamKeysPaged(uint256 tokenId, uint256 start, uint256 count)
        public
        view
        returns (bytes32[] memory keys, uint256 total)
    {
        return _pageKeys(ParamsStorage.layout().tokenParamKeyList[tokenId], start, count);
    }

    function contractParamKeys() public view returns (bytes32[] memory keys) {
        (keys,) = _pageKeys(ParamsStorage.layout().contractParamKeyList, 0, type(uint256).max);
    }

    function contractParamKeysPaged(uint256 start, uint256 count)
        public
        view
        returns (bytes32[] memory keys, uint256 total)
    {
        return _pageKeys(ParamsStorage.layout().contractParamKeyList, start, count);
    }

    function paramSchema(bytes32 key)
        public
        view
        returns (
            bool exists,
            IAbxConfigurableParams.ParamType paramType,
            IAbxConfigurableParams.AuthOption auth,
            address authAddress,
            uint48 lockAfter,
            bytes32 min,
            bytes32 max,
            string[] memory selectOptions
        )
    {
        ConfigurableParamsStorage.Schema storage s =
            ConfigurableParamsStorage.layout().schemas[key];
        return
            (s.exists, s.paramType, s.auth, s.authAddress, s.lockAfter, s.min, s.max, s.selectOptions);
    }

    /// @notice A schema's fixed-size head, without its `selectOptions` array.
    /// @dev The hot read path needs the TYPE, not the table. `paramSchema` returns the whole
    ///      `string[]`, so a renderer resolving one selected option copies every option on every
    ///      render — an owner-created 200-entry table is then paid for by every `tokenURI` call for
    ///      the life of the project, to look up one index.
    ///
    ///      Pair this with {selectOption} to read exactly the one entry that matters. `paramSchema`
    ///      stays for introspection (a UI building a picker genuinely wants the whole table).
    function paramSchemaHead(bytes32 key)
        public
        view
        returns (
            bool exists,
            IAbxConfigurableParams.ParamType paramType,
            IAbxConfigurableParams.AuthOption auth,
            address authAddress,
            uint48 lockAfter,
            bytes32 min,
            bytes32 max,
            uint256 selectOptionCount
        )
    {
        ConfigurableParamsStorage.Schema storage s =
            ConfigurableParamsStorage.layout().schemas[key];
        return (
            s.exists, s.paramType, s.auth, s.authAddress, s.lockAfter, s.min, s.max,
            s.selectOptions.length
        );
    }

    /// @notice One option from a `Select` schema's table, by index. Empty string when out of range —
    ///         a read path must not revert on a value that merely does not resolve.
    function selectOption(bytes32 key, uint256 index) public view returns (string memory) {
        string[] storage options = ConfigurableParamsStorage.layout().schemas[key].selectOptions;
        if (index >= options.length) return "";
        return options[index];
    }

    /// @dev Whether `key` has a schema (the mixins' composing guards read this).
    function paramHooksLocked() public view returns (bool) {
        return ConfigurableParamsStorage.layout().hooksLocked;
    }

    function hasSchema(bytes32 key) public view returns (bool) {
        return ConfigurableParamsStorage.layout().schemas[key].exists;
    }

    function paramHooks()
        public
        view
        returns (address configureHook, address augmentHook, address transferHook)
    {
        ConfigurableParamsStorage.Layout storage l = ConfigurableParamsStorage.layout();
        return (l.configureHook, l.augmentHook, l.transferHook);
    }

    function delegateRegistry() public view returns (address) {
        return ConfigurableParamsStorage.layout().delegateRegistry;
    }

    function paramSchemaKeys() public view returns (bytes32[] memory keys) {
        (keys,) =
            _pageKeys(ConfigurableParamsStorage.layout().schemaKeyList, 0, type(uint256).max);
    }

    function paramSchemaKeysPaged(uint256 start, uint256 count)
        public
        view
        returns (bytes32[] memory keys, uint256 total)
    {
        return _pageKeys(ConfigurableParamsStorage.layout().schemaKeyList, start, count);
    }

    // ── internals ─────────────────────────────────────────────────────────────

    /// @dev Append `key` to a scope's key list unless it is already there — membership is the
    ///      index mapping alone (`0` = absent), never `isSet`, so the list stays self-contained.
    ///      The reserved `seed` key is skipped: see {SEED_KEY}.
    function _index(
        bytes32[] storage list,
        mapping(bytes32 key => uint256) storage index,
        bytes32 key
    ) private {
        if (key == SEED_KEY || index[key] != 0) {
            return;
        }
        list.push(key);
        index[key] = list.length; // 1-based
    }

    /// @dev Swap-and-pop `key` out of a scope's key list: the last entry takes its slot (and its
    ///      index is corrected), then the list shortens. Order is insertion order only until the
    ///      first removal — unspecified to consumers by design, which is what makes this legal.
    ///      A key that was never indexed (`seed`) is a no-op, so the clear paths stay uniform.
    function _unindex(
        bytes32[] storage list,
        mapping(bytes32 key => uint256) storage index,
        bytes32 key
    ) private {
        uint256 at = index[key]; // 1-based
        if (at == 0) return;
        uint256 last = list.length;
        if (at != last) {
            bytes32 moved = list[last - 1];
            list[at - 1] = moved;
            index[moved] = at;
        }
        list.pop();
        delete index[key];
    }

    /// @dev The one windowed key read, shared by every enumerable list above. Clamps to the end
    ///      rather than reverting, so an out-of-range `start` reads as "done", not as an error.
    function _pageKeys(bytes32[] storage list, uint256 start, uint256 count)
        private
        view
        returns (bytes32[] memory keys, uint256 total)
    {
        total = list.length;
        if (start >= total) return (new bytes32[](0), total);
        unchecked {
            // `start < total` and `i < n <= total - start`, so neither can wrap.
            uint256 n = total - start;
            if (n > count) n = count;
            keys = new bytes32[](n);
            for (uint256 i; i < n; ++i) {
                keys[i] = list[start + i];
            }
        }
    }

    function _requireConfigurable(uint256 tokenId, bytes32 key, address creator)
        private
        view
        returns (ConfigurableParamsStorage.Schema storage s)
    {
        s = ConfigurableParamsStorage.layout().schemas[key];
        if (!s.exists) revert NoParamSchema();
        uint48 lockAfter = s.lockAfter;
        if (lockAfter != 0 && block.timestamp > lockAfter) revert ParamLockExpired();
        if (!_isAuthorized(s, tokenId, creator)) revert NotParamAuthorized();
    }

    /// @dev OR-semantics over the schema's named parties. `Creator` = the contract owner; the
    ///      token-owner leg **generalizes to 721-owner OR 1155-any-holder** — see
    ///      {_isAuthorizedOwnerLeg} — and honors **delegate.xyz** on the 721 side (the configured
    ///      registry): a wallet the token owner delegated to (all-wallet, per-contract, or
    ///      per-token; rights-agnostic) configures as the owner, so vaulted tokens configure from
    ///      a hot wallet.
    function _isAuthorized(
        ConfigurableParamsStorage.Schema storage s,
        uint256 tokenId,
        address creator
    ) private view returns (bool) {
        IAbxConfigurableParams.AuthOption a = s.auth;
        bool creatorLeg = a == IAbxConfigurableParams.AuthOption.Creator
            || a == IAbxConfigurableParams.AuthOption.CreatorOrTokenOwner
            || a == IAbxConfigurableParams.AuthOption.CreatorOrAddress
            || a == IAbxConfigurableParams.AuthOption.CreatorOrTokenOwnerOrAddress;
        if (creatorLeg && msg.sender == creator) return true;
        bool addressLeg = a == IAbxConfigurableParams.AuthOption.Address
            || a == IAbxConfigurableParams.AuthOption.CreatorOrAddress
            || a == IAbxConfigurableParams.AuthOption.TokenOwnerOrAddress
            || a == IAbxConfigurableParams.AuthOption.CreatorOrTokenOwnerOrAddress;
        if (addressLeg && msg.sender == s.authAddress) return true;
        bool ownerLeg = a == IAbxConfigurableParams.AuthOption.TokenOwner
            || a == IAbxConfigurableParams.AuthOption.CreatorOrTokenOwner
            || a == IAbxConfigurableParams.AuthOption.TokenOwnerOrAddress
            || a == IAbxConfigurableParams.AuthOption.CreatorOrTokenOwnerOrAddress;
        if (ownerLeg && _isAuthorizedOwnerLeg(tokenId)) return true;
        return false;
    }

    /// @dev The TokenOwner auth leg, adaptive to the composing token's standard. `address(this)`
    ///      is the token under delegatecall either way.
    ///
    ///      **721 path** (unchanged behavior): guarded-staticcall `ownerOf(tokenId)` — success ⇒
    ///      this IS a 721-shaped token; `msg.sender` qualifies if it's the owner OR a delegate.xyz
    ///      delegate of the owner (`checkDelegateForERC721`, the pre-existing check, untouched).
    ///
    ///      **1155 path** (new, editions): the `ownerOf` probe fails — no such function on an
    ///      ERC-1155 base — so fall back to "any holder qualifies":
    ///      `balanceOf(msg.sender, tokenId) > 0` — params are per-id shared state of the
    ///      work, not a single owner's; last-writer-wins among holders is the intended
    ///      semantic). **Documented gap, not silently resolved**: delegate.xyz's
    ///      `checkDelegateForERC1155(to, from, contract_, tokenId, rights)` needs an explicit
    ///      `from` (vault) address, and an ERC-1155 id can have many holders with no on-chain
    ///      enumeration to pick one from — there is no analogue of the 721 leg's "the one owner"
    ///      to resolve a delegation against without the caller naming the vault. So a vaulted
    ///      holder configures directly from that vault; delegated hot-wallet configuration for
    ///      editions is out of scope for this pass, not implemented as a guess.
    ///
    ///      Both probes are guarded staticcalls: neither the 721 nor 1155 Solady base defines a
    ///      fallback function, so an unrecognized selector simply reverts and is caught here,
    ///      never confused with a genuine `ownerOf` return of `address(0)` (which Solady's
    ///      ERC-721 itself would revert on via `TokenDoesNotExist`, so `success == true` here
    ///      always carries a real, non-zero owner).
    function _isAuthorizedOwnerLeg(uint256 tokenId) private view returns (bool) {
        (bool has721Owner, address tokenOwner) = _probeOwnerOf(tokenId);
        if (has721Owner) {
            if (msg.sender == tokenOwner) return true;
            return _isDelegated(msg.sender, tokenOwner, tokenId);
        }
        return _holdsErc1155Balance(msg.sender, tokenId);
    }

    /// @dev Guarded probe for ERC-721's `ownerOf(uint256)` (selector `0x6352211e`). Never reverts
    ///      the caller's frame: `ok == false` on any failure (no such function, or a revert
    ///      inside `ownerOf` itself, e.g. a nonexistent token).
    function _probeOwnerOf(uint256 tokenId) private view returns (bool ok, address tokenOwner) {
        (bool success, bytes memory ret) =
            address(this).staticcall(abi.encodeWithSelector(0x6352211e, tokenId));
        if (success && ret.length == 32) return (true, abi.decode(ret, (address)));
        return (false, address(0));
    }

    /// @dev The ERC-1155 any-holder leg: `balanceOf(sender, tokenId) > 0` qualifies directly.
    ///      Guarded the same way as {_probeOwnerOf} for symmetry; a token composing neither
    ///      surface simply never authorizes on the TokenOwner leg.
    function _holdsErc1155Balance(address sender, uint256 tokenId) private view returns (bool) {
        (bool success, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(0x00fdd58e, sender, tokenId) // balanceOf(address,uint256)
        );
        return success && ret.length == 32 && abi.decode(ret, (uint256)) > 0;
    }

    /// @dev Fail-closed delegate.xyz check: a missing/odd registry (no code, bad return) is
    ///      simply "not delegated" — the direct-owner path is never affected. Rights-agnostic
    ///      (`bytes32(0)`), matching the AB PostParams integration.
    function _isDelegated(address delegate, address vault, uint256 tokenId)
        private
        view
        returns (bool)
    {
        address registry = ConfigurableParamsStorage.layout().delegateRegistry;
        if (registry == address(0) || registry.code.length == 0) return false;
        bytes memory probe = abi.encodeCall(
            IDelegateRegistry.checkDelegateForERC721,
            (delegate, vault, address(this), tokenId, bytes32(0))
        );
        // Bounded staticcall, and accept ONLY the canonical `true` word. `abi.decode(ret, (bool))`
        // REVERTS on a word that is neither 0 nor 1, so a registry returning `2` took down the
        // authorization check that was documented as fail-closed — the one shape a fail-closed path
        // must survive. The output window is capped at 32 bytes so a huge return cannot be charged
        // to this frame either.
        uint256 word;
        bool ok;
        assembly {
            let outcome := staticcall(gas(), registry, add(probe, 0x20), mload(probe), 0x00, 0x20)
            ok := and(outcome, eq(returndatasize(), 32))
            word := mload(0x00)
        }
        return ok && word == 1;
    }

    function _validateLiteral(ConfigurableParamsStorage.Schema storage s, bytes32 value)
        private
        view
    {
        IAbxConfigurableParams.ParamType t = s.paramType;
        uint256 v = uint256(value);
        if (t == IAbxConfigurableParams.ParamType.Bool) {
            if (v > 1) revert InvalidParamValue();
        } else if (t == IAbxConfigurableParams.ParamType.Select) {
            if (v >= s.selectOptions.length) revert InvalidParamValue();
        } else if (t == IAbxConfigurableParams.ParamType.HexColor) {
            if (v > 0xFFFFFF) revert InvalidParamValue();
        } else if (t == IAbxConfigurableParams.ParamType.Int256Range) {
            // reinterpreting the bytes32 as two's-complement signed is the type's encoding.
            // forge-lint: disable-next-line(unsafe-typecast)
            int256 sv = int256(v);
            if (sv < int256(uint256(s.min)) || sv > int256(uint256(s.max))) {
                revert InvalidParamValue();
            }
        } else {
            // Uint256Range · DecimalRange · Timestamp — unsigned bounds; max = 0 ⇒ unbounded above
            if (v < uint256(s.min)) revert InvalidParamValue();
            uint256 hi = uint256(s.max);
            if (hi != 0 && v > hi) revert InvalidParamValue();
        }
    }

    /// @dev The write-time veto: a configured hook's revert bubbles (the validator slot).
    ///      `dataLength`/`dataBlobAddress` are zero on the scalar path and describe the freshly
    ///      written blob on the data path — see {IAbxConfigureHook-onParamConfigured} for the
    ///      contract, the guaranteed `keccak256(SSTORE2.read(blob)) == value` invariant, and why the
    ///      blob is an address rather than bytes.
    function _runConfigureHook(
        uint256 tokenId,
        bytes32 key,
        bytes32 value,
        uint256 dataLength,
        address dataBlobAddress
    ) private {
        address hook = ConfigurableParamsStorage.layout().configureHook;
        if (hook == address(0)) return;
        IAbxConfigureHook(hook).onParamConfigured(
            tokenId, key, value, msg.sender, dataLength, dataBlobAddress
        );
    }
}
