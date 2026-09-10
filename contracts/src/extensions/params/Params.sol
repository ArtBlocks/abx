// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxParams} from "./IAbxParams.sol";
import {ParamsStorage} from "../../libraries/ParamsStorage.sol";
import {AbxParamsLib} from "../../libraries/AbxParamsLib.sol";

/// @title Params — the ABX Params extension (Register 2), as a mixin
/// @notice A token opts into general `key → bytes` on-chain metadata by inheriting this: a
///         `seed`, trait inputs, content pointers — anything the output is a function of.
/// @notice Small values ride the event as a `bytes32` literal; a large value (sprite data, long
///         strings) is **one SSTORE2 blob — never multi-chunk** (one bound, one read; content
///         above the ~24 KB ceiling is a pointer param), with its keccak256 as the evented
///         value (`valueIsHash = true`), read back via the data views.
/// @dev Owner-settable by default; composing layers narrow that — {ConfigurableParams} routes
///      schema-governed keys through its typed, auth-checked path via the `_checkParamWrite`
///      guard, and a token can add key-specific rules (e.g. the settled-`seed` promise) the same
///      way. Internal `_setTokenParam` skips the guard: it is the token's own privileged path
///      (mint-time seed, hooks) and carries its own `updatedBy`. Every write pings ERC-4906.
///      The write paths and the key-enumeration reads live in {AbxParamsLib} — a shared external
///      library, delegatecalled, so storage stays in this token's ERC-7201 namespace and events
///      log from the token (the spine is identical to an inlined implementation; EIP-170 is why
///      it's a library). Self-registers its version in `_initParams`.
abstract contract Params is AbxBeaconCore, Ownable, IAbxParams {
    /// @dev keccak256("abx.extension.params") — permanent extension id. `private` so it never
    ///      collides with another extension's `ID` in a composing token.
    bytes32 private constant ID =
        0x710d217d7719955f00168e31b6b8c3c9fb8255d7caaea0010e20d28ca7fdb8a9;

    /// @dev Current implemented version (bumps when `IAbxParams` or semantics change).
    ///      v2 added the key-enumeration reads.
    uint16 private constant VERSION = 2;

    // ── owner writes (guarded) ──────────────────────────────────────────────--

    // The owner WRITE shells are raw-calldata passthroughs to {AbxParamsLib}, exactly
    // like the read shells below. The gate that lived here — `onlyOwner` + the `_checkParamWrite`
    // schema-governance check — moved into the library front doors of the same selector
    // ({AbxParamsLib-_requireOwner} / {AbxParamsLib-_requireUngoverned}); a typed shell that
    // re-encodes these args (a `bytes` blob among them) costs more than the extracted body saved,
    // and the code tokens had no room to spare. `msg.sender` (the caller) and `owner()` (from
    // storage) are both read in the library — delegatecall preserves them.

    /// @notice Owner sets/replaces a token param with a literal `bytes32` value.
    function setTokenParam(uint256, /* tokenId */ bytes32, /* key */ bytes32 /* value */ ) external {
        _delegateParamsWrite();
    }

    /// @notice Owner sets/replaces a token param with a large value — one blob, ≤ the SSTORE2
    ///         ceiling. The evented value is the keccak256 of the content.
    function setTokenParamData(uint256, /* tokenId */ bytes32, /* key */ bytes calldata /* data */ )
        external
    {
        _delegateParamsWrite();
    }

    /// @notice Owner removes a token param. Explicit — distinct from setting it to zero.
    function clearTokenParam(uint256, /* tokenId */ bytes32 /* key */ ) external {
        _delegateParamsWrite();
    }

    /// @notice Owner sets/replaces a contract param with a literal `bytes32` value.
    function setContractParam(bytes32, /* key */ bytes32 /* value */ ) external {
        _delegateParamsWrite();
    }

    /// @notice Owner sets/replaces a contract param with a large value — one blob, ≤ the
    ///         SSTORE2 ceiling. The evented value is the keccak256 of the content.
    function setContractParamData(bytes32, /* key */ bytes calldata /* data */ ) external {
        _delegateParamsWrite();
    }

    /// @notice Owner removes a contract param. Explicit — distinct from setting it to zero.
    /// @dev Owner-gated but deliberately NOT schema-governance-checked, unlike the two contract-scope
    ///      setters above — the library front door ({AbxParamsLib-clearContractParam}) enforces the
    ///      owner gate and skips {AbxParamsLib-_requireUngoverned} on purpose.
    ///
    ///      The governance guard refuses any raw write to a schema-governed key, so governed values
    ///      can only move through the typed, auth-checked path. But that path is TOKEN-scope only —
    ///      there is no governed contract-scope write — so applying the guard here would leave
    ///      contract scope with no exit at all: attach a schema to a key that already holds a
    ///      contract-scope value and the value is frozen permanently, for every token, by two
    ///      ordinary owner calls. With a malformed `String` value that means every `tokenURI` in the
    ///      collection is poisoned with no way back, and once `lockAfter` bites even re-typing the
    ///      schema reverts.
    ///
    ///      Clearing is the safe half of the pair: it removes a fallback, it cannot forge a value or
    ///      bypass an auth rule, and the schema keeps governing every token-scope write exactly as
    ///      before. Same reasoning as the `HexColor` clamp and `_requireCanonicalKey` — an ordinary
    ///      operation with plausible intent should not be able to reach an unrecoverable state.
    function clearContractParam(bytes32 /* key */ ) external {
        _delegateParamsWrite();
    }

    // ── reads ───────────────────────────────────────────────────────────────--

    /// @inheritdoc IAbxParams
    function tokenParam(uint256 tokenId, bytes32 key)
        external
        view
        returns (bytes32 value, bool valueIsHash, bool isSet)
    {
        ParamsStorage.Param storage p = ParamsStorage.layout().tokenParams[tokenId][key];
        return (p.value, p.valueIsHash, p.isSet);
    }

    /// @inheritdoc IAbxParams
    function contractParam(bytes32 key)
        external
        view
        returns (bytes32 value, bool valueIsHash, bool isSet)
    {
        ParamsStorage.Param storage p = ParamsStorage.layout().contractParams[key];
        return (p.value, p.valueIsHash, p.isSet);
    }

    /// @inheritdoc IAbxParams
    function tokenParamData(uint256 tokenId, bytes32 key) external view returns (bytes memory) {
        address ptr = ParamsStorage.layout().tokenData[tokenId][key];
        return ptr == address(0) ? bytes("") : SSTORE2.read(ptr);
    }

    /// @inheritdoc IAbxParams
    function contractParamData(bytes32 key) external view returns (bytes memory) {
        address ptr = ParamsStorage.layout().contractData[key];
        return ptr == address(0) ? bytes("") : SSTORE2.read(ptr);
    }

    /// @inheritdoc IAbxParams
    function tokenParamKeys(uint256 /* tokenId */ )
        external
        view
        returns (bytes32[] memory /* keys */ )
    {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxParams
    function tokenParamKeysPaged(uint256 /* tokenId */, uint256 /* start */, uint256 /* count */ )
        external
        view
        returns (bytes32[] memory, /* keys */ uint256 /* total */ )
    {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxParams
    function contractParamKeys() external view returns (bytes32[] memory /* keys */ ) {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxParams
    function contractParamKeysPaged(uint256 /* start */, uint256 /* count */ )
        external
        view
        returns (bytes32[] memory, /* keys */ uint256 /* total */ )
    {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    // ── internals ─────────────────────────────────────────────────────────────

    /// @dev Raw passthrough for the externalized read views (above + {ConfigurableParams}'
    ///      schema reads): delegatecalls {AbxParamsLib} with this call's exact calldata — the
    ///      library declares the same signature, so the selector dispatches there — and returns
    ///      the library's return data untouched, since it already encodes this function's exact
    ///      return ABI. A typed Solidity call site would decode + re-encode the dynamic returns,
    ///      costing more bytes than the extracted bodies save (EIP-170 is why the reads moved at
    ///      all). Every target is a view, but the mutability checker flags any raw
    ///      `delegatecall`, so the pointer cast below launders it — a runtime no-op (internal
    ///      function pointers are bare jump destinations). Never returns.
    function _delegateParamsRead() internal view {
        function() internal fn = _delegateParamsReadRaw;
        function() internal view viewFn;
        assembly {
            viewFn := fn
        }
        viewFn();
    }

    /// @dev The WRITE passthrough: forward this call's raw calldata to {AbxParamsLib} and return
    ///      its returndata (the extracted owner-gated write front doors run there). Same mechanism
    ///      as {_delegateParamsRead}, minus the view cast — writes change state.
    function _delegateParamsWrite() internal {
        _delegateParamsReadRaw();
    }

    /// @dev The raw forward. Non-view only because assembly `delegatecall` is always flagged.
    function _delegateParamsReadRaw() private {
        address lib = address(AbxParamsLib);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), lib, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    /// @dev Whether a token param is currently set (for composing guards / mint-time seed).
    function _tokenParamIsSet(uint256 tokenId, bytes32 key) internal view returns (bool) {
        return ParamsStorage.layout().tokenParams[tokenId][key].isSet;
    }

    /// @dev The token's own privileged write (mint-time seed, hooks) — skips the guard and
    ///      carries its own `updatedBy` for provenance.
    function _setTokenParam(
        uint256 tokenId,
        bytes32 key,
        bytes32 value,
        bool valueIsHash,
        address updatedBy
    ) internal {
        AbxParamsLib.setTokenParam(tokenId, key, value, valueIsHash, updatedBy);
    }

    /// @dev Enable the extension (announce version). Call at initialize.
    function _initParams() internal {
        _setExtensionVersion(ID, VERSION);
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
            || interfaceId == type(IAbxParams).interfaceId;
    }
}
