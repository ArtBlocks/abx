// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxConfigurableParams — Configurable Params (PostParams) vocabulary (Register 2)
/// @notice User-configurable params with an **on-chain schema**, so any frontend builds the
///         config UI from chain. Layers on the Params extension (which stores `key → bytes`);
///         this declares what keys *mean* and *who may set them*. A param can stand alone with
///         no schema (a `seed`, a pointer); a schema is opt-in per key, and is what makes a
///         param a governed, typed PostParam.
/// @dev Schema is small/bounded → emitted **in full** (no follow-up read). A schema change is
///      contract-level output-affecting: `BatchMetadataUpdate` + it reinterprets every token's
///      bytes under the new type. Values flow through `TokenParamConfigured`. The canonical
///      decode (each type → a canonical string for code-based work) is versioned in the spec and
///      implemented off-chain (SDK) + on-chain (TokenDataLib) — never here.
interface IAbxConfigurableParams {
    /// @notice The declared type of a param key — the AB PMP set + `Bytes`. Named `paramType`
    ///         throughout because `type` is a reserved word.
    enum ParamType {
        Bool, // value ∈ {0, 1}
        Select, // value = index into `selectOptions`
        Uint256Range, // min ≤ value ≤ max (unsigned; max = 0 ⇒ unbounded above)
        Int256Range, // min ≤ value ≤ max (two's-complement signed bounds, both enforced)
        DecimalRange, // as Uint256Range; fixed-point, 10 decimals — canonical decode ÷ 1e10 (PMP-compatible)
        HexColor, // value ≤ 0xFFFFFF; canonical decode → "#rrggbb"
        Timestamp, // as Uint256Range; canonical decode → unix seconds
        String, // well-formed UTF-8 via the data path (one blob + its hash); no literal form
        Bytes // raw bytes via the data path (one blob + its hash); canonical decode → base64
    }

    /// @notice Who may set a key's value (OR semantics — any listed party). `Creator` = the
    ///         contract owner (ABX has no separate creator role; one project per contract).
    ///         `TokenOwner` on an ERC-721 honors **delegate.xyz v2** full delegations (all-wallet,
    ///         per-contract or per-token, created with `rights == 0`; rights-scoped delegations
    ///         do not qualify) via the configured registry — default the canonical v2 deployment;
    ///         opt-out at deploy — so vaulted tokens configure from a hot wallet. On an ERC-1155
    ///         edition `TokenOwner` means any current holder of the id, and delegation is not
    ///         consulted.
    enum AuthOption {
        Creator,
        TokenOwner,
        Address,
        CreatorOrTokenOwner,
        CreatorOrAddress,
        TokenOwnerOrAddress,
        CreatorOrTokenOwnerOrAddress
    }

    // ── errors (declared here so they decode against the token's ABI; see {IAbxParams}) ────────

    /// @notice A governed write named a key that has no schema.
    error NoParamSchema(bytes32 key);
    /// @notice The caller does not satisfy the key's schema auth for this token. Carries the auth
    ///         that was enforced, so the reason is readable without a second (possibly racing)
    ///         read: `auth` is the schema's {AuthOption} and `authAddress` its named address
    ///         (zero unless the option has an Address leg). `TokenOwner` means the token's current
    ///         ERC-721 owner or a full delegate.xyz delegate of it, or on an edition any current
    ///         holder of the id.
    error NotParamAuthorized(
        bytes32 key, uint256 tokenId, address caller, AuthOption auth, address authAddress
    );
    /// @notice The key's `lockAfter` deadline has passed: its value and its schema are final.
    error ParamLockExpired(bytes32 key, uint48 lockAfter);
    /// @notice A `lockAfter` deadline may only be brought FORWARD, never pushed back and never
    ///         cleared. Retiring a param is meant to be permanent; a re-openable lock is not a lock.
    error ParamLockNotExtendable(bytes32 key);
    /// @notice The value does not satisfy the key's schema (range, option index, color, or
    ///         well-formed UTF-8 for a `String`).
    error InvalidParamValue(bytes32 key, uint256 tokenId);
    /// @notice The schema is malformed for its type: options on a non-`Select`, an empty or
    ///         non-UTF-8 option label, bounds on a type that does not use them, inverted bounds,
    ///         an auth address that does not match the auth option, or a `String`/`Bytes` type
    ///         for `seed` (a seed is never data-backed).
    error InvalidParamSchema(bytes32 key);
    /// @notice The write used the literal path for a data type (`String`/`Bytes`) or vice versa.
    error WrongValuePath(bytes32 key, ParamType paramType);
    /// @notice The key has a schema, so it is governed: raw owner setters are closed for it and the
    ///         write must go through `configureTokenParam*`.
    error SchemaGoverned(bytes32 key);
    /// @notice The hook set is frozen — `setParamHooks` is closed forever on this collection.
    error ParamHooksLocked();
    /// @notice `setDelegateRegistry` accepts only the canonical delegate.xyz v2 registry or
    ///         `address(0)`; an owner-chosen registry could authorize the owner as anyone's delegate.
    error InvalidDelegateRegistry(address registry);
    /// @notice A non-zero hook address has no code. A codeless configure or transfer hook makes
    ///         every call to it revert with no reason — every mint and transfer, for a transfer
    ///         hook — and a codeless augment hook is silently ignored by readers; `lockParamHooks`
    ///         would make either permanent.
    error InvalidParamHook(address hook);

    /// @notice A key's schema was set or changed — emitted in full (the inline rule).
    event ParamSchemaConfigured(
        bytes32 indexed key,
        ParamType paramType,
        AuthOption auth,
        address authAddress,
        uint48 lockAfter,
        bytes32 min,
        bytes32 max,
        string[] selectOptions
    );

    /// @notice The project's param-lifecycle hook addresses were set.
    event HooksConfigured(address configureHook, address augmentHook, address transferHook);

    /// @notice The hook set was frozen forever — no hook address can be set, re-pointed or cleared
    ///         again. Declared HERE, not only in the library that emits it, so it reaches every
    ///         composing token's ABI and the event spine can index it. It could not before, which
    ///         meant the one signal that a transfer veto can never be armed against a holder was
    ///         invisible to every indexer.
    event ParamHooksFrozen();

    /// @notice Whether the hook set is frozen (see `ParamHooksFrozen`). The read a buyer uses
    ///         alongside `paramHooks()`: three addresses tell you what runs today, this tells you
    ///         whether that can still change. Mirrors `scriptLocked()` / `dependenciesLocked()`.
    function paramHooksLocked() external view returns (bool);

    /// @notice The TokenOwner-leg delegation resolver was set (zero = delegation disabled). On an
    ///         ERC-721 code token, absence of the event ⇒ the default: the canonical delegate.xyz
    ///         v2 registry. An ERC-1155 edition stores zero, emits nothing at deploy, and never
    ///         consults a registry (`TokenOwner` there means any current holder).
    event DelegateRegistrySet(address indexed registry);

    /// @notice A schema's fixed-size head plus its option COUNT — the hot-read-path shape.
    /// @dev Use with {selectOption} rather than `paramSchema` when resolving one selected value: the
    ///      full getter copies the entire option table on every call, so a large owner-created table
    ///      is paid for by every render, forever, to look up one index.
    function paramSchemaHead(bytes32 key)
        external
        view
        returns (
            bool exists,
            ParamType paramType,
            AuthOption auth,
            address authAddress,
            uint48 lockAfter,
            bytes32 min,
            bytes32 max,
            uint256 selectOptionCount
        );

    /// @notice One option from a `Select` schema's table. Empty string when out of range.
    function selectOption(bytes32 key, uint256 index) external view returns (string memory);

    /// @notice A key's full schema. `exists` = false ⇒ the key is ungoverned (plain param).
    function paramSchema(bytes32 key)
        external
        view
        returns (
            bool exists,
            ParamType paramType,
            AuthOption auth,
            address authAddress,
            uint48 lockAfter,
            bytes32 min,
            bytes32 max,
            string[] memory selectOptions
        );

    /// @notice The project's param-lifecycle hooks (any may be zero = none).
    function paramHooks()
        external
        view
        returns (address configureHook, address augmentHook, address transferHook);

    /// @notice The TokenOwner-leg delegation resolver (`address(0)` = delegation disabled).
    function delegateRegistry() external view returns (address);

    /// @notice Every key this project has declared a schema for, in declaration order — the
    ///         governed vocabulary, readable from chain alone. **Append-only:** a schema is
    ///         updated in place, never deleted, so a key never leaves. Distinct from
    ///         `IAbxParams.tokenParamKeys`, which lists keys with a *value*: a declared key with
    ///         no value yet appears only here, and that is exactly what a configure UI needs.
    function paramSchemaKeys() external view returns (bytes32[] memory);

    /// @notice A window on `paramSchemaKeys` — up to `count` keys from `start`, plus `total`
    ///         (the full list length); a `start` at or past the end returns empty.
    function paramSchemaKeysPaged(uint256 start, uint256 count)
        external
        view
        returns (bytes32[] memory keys, uint256 total);
}
