// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Params} from "../params/Params.sol";
import {IAbxConfigurableParams} from "./IAbxConfigurableParams.sol";
import {IAbxTransferHook} from "./IAbxParamHooks.sol";
import {ConfigurableParamsStorage} from "../../libraries/ConfigurableParamsStorage.sol";
import {AbxParamsLib} from "../../libraries/AbxParamsLib.sol";

/// @title ConfigurableParams — the ABX Configurable Params (PostParams) extension, as a mixin
/// @notice Layers governance on {Params}: a per-key **schema** (type · auth · constraints ·
///         lock-after) plus the project's three lifecycle hooks. A schema'd key stops being
///         owner metadata and becomes a governed PostParam: values are written through the
///         typed, auth-checked `configureTokenParam*` path — by whoever the schema names
///         (`Creator` = the contract owner, `TokenOwner`, a specific `Address`, or combinations)
///         — and the owner's raw setters are closed for it (the `_checkParamWrite` guard).
/// @dev Values flow through the base store (`TokenParamConfigured`, `updatedBy` = the
///      configurer). The configureHook is a write-time **veto** (its revert bubbles); the
///      transferHook is a **veto** (its revert bubbles and fails the transfer or mint; freezable
///      with `lockParamHooks`); the augmentHook is read-time, consumed off-token. Schema and
///      hooks reconstruct from `ParamSchemaConfigured` / `HooksConfigured` alone. The write
///      paths and the schema reads live in {AbxParamsLib} (shared external library,
///      delegatecalled — see {Params}). Storage is ERC-7201 (`ConfigurableParamsStorage`).
///      Self-registers in `_initConfigurableParams`.
abstract contract ConfigurableParams is Params, IAbxConfigurableParams {
    /// @dev keccak256("abx.extension.configurable-params") — permanent extension id.
    bytes32 private constant ID =
        0x0245d8eeb976653d00fd45d239be9beef9164b46f7e4864bb70910530da6fb35;

    /// @dev Current implemented version (bumps when the interface or semantics change).
    ///      v2 added the schema-key enumeration reads.
    /// @dev v3: `IAbxConfigureHook.onParamConfigured` gained `dataLength` + `dataBlobAddress`, so the
    ///      beacon's `extensionVersion` is how an integrator tells which calling convention a
    ///      deployed token uses. A v2 token calls the 4-argument form; a v3 token calls the
    ///      6-argument one, and a hook written for one will revert on the other.
    uint16 private constant VERSION = 3;

    /// @dev The canonical delegate.xyz v2 registry — the same CREATE2 address on every chain.
    ///      The TokenOwner-leg default; opt-out at deploy, re-pointable by the owner.
    address private constant DEFAULT_DELEGATE_REGISTRY =
        0x00000000000000447e69651d841bD8D104Bed493;

    /// @notice The key has a schema — writes go through `configureTokenParam*`, not raw setters.
    error SchemaGoverned();

    // ── schema + hooks (owner) ──────────────────────────────────────────────--

    /// @notice Owner declares/updates a key's schema. Contract-level and output-affecting:
    ///         re-types every token's bytes under the new schema (`BatchMetadataUpdate`).
    /// @dev The ONE write shell that is a typed call, not a raw passthrough — and it must stay that
    ///      way. Solidity computes an external LIBRARY function's selector from the parameters'
    ///      declared type names, so {AbxParamsLib-setParamSchema}'s enum params make its selector
    ///      `keccak("setParamSchema(bytes32,IAbxConfigurableParams.ParamType,...)")` — NOT the
    ///      canonical `...(bytes32,uint8,uint8,...)` this token's external ABI advertises. A raw
    ///      passthrough forwards THIS token's (canonical) selector, which the library's dispatcher
    ///      does not carry, so the call reverts "unrecognized selector". A typed call uses the
    ///      library's own selector and dispatches correctly. Every other front door has only
    ///      canonical ABI types, so its two selectors coincide and the passthrough works.
    ///      `onlyOwner` therefore stays here for this function (the library front doors gate the rest).
    function setParamSchema(
        bytes32 key,
        ParamType paramType,
        AuthOption auth,
        address authAddress,
        uint48 lockAfter,
        bytes32 min,
        bytes32 max,
        string[] calldata selectOptions
    ) external onlyOwner {
        AbxParamsLib.setParamSchema(
            key, paramType, auth, authAddress, lockAfter, min, max, selectOptions
        );
    }

    /// @notice Owner sets the project's lifecycle hook addresses (any may be zero = none).
    /// @dev Owner-only, permanently — there is deliberately no permissionless path here, not even
    ///      on an ownerless collection. See {AbxParamsLib-setParamHooks} for why a transfer hook is
    ///      not the transfer validator and must not inherit the validator's dead-man release.
    function setParamHooks(address, /* configureHook */ address, /* augmentHook */ address /* transferHook */ )
        external
    {
        _delegateParamsWrite();
    }

    /// @notice Owner freezes the hook set forever — no hook address can change after this.
    /// @dev The commitment that turns the transfer hook from a standing power into a disclosed,
    ///      verifiable one. Irreversible on purpose; a lock a project can lift is not a lock.
    function lockParamHooks() external {
        _delegateParamsWrite();
    }

    /// @notice Owner re-points (or zeroes = disables) the TokenOwner-leg delegation resolver.
    function setDelegateRegistry(address /* registry */ ) external {
        _delegateParamsWrite();
    }

    // ── the governed write path ─────────────────────────────────────────────--

    /// @notice Set a schema-governed token param to a literal `bytes32` value, as whoever the
    ///         schema authorizes. Scalar types only; `String`/`Bytes` use the data path.
    function configureTokenParam(uint256, /* tokenId */ bytes32, /* key */ bytes32 /* value */ ) external {
        _delegateParamsWrite();
    }

    /// @notice Set a schema-governed `String`/`Bytes` token param. The evented value is the
    ///         keccak256 of `data`, stored as a single chunk.
    function configureTokenParamData(uint256, /* tokenId */ bytes32, /* key */ bytes calldata /* data */ )
        external
    {
        _delegateParamsWrite();
    }

    // ── reads ───────────────────────────────────────────────────────────────--

    /// @inheritdoc IAbxConfigurableParams
    function paramSchema(bytes32 /* key */ )
        external
        view
        returns (
            bool, /* exists */
            ParamType, /* paramType */
            AuthOption, /* auth */
            address, /* authAddress */
            uint48, /* lockAfter */
            bytes32, /* min */
            bytes32, /* max */
            string[] memory /* selectOptions */
        )
    {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxConfigurableParams
    function paramSchemaHead(bytes32 /* key */ )
        external
        view
        returns (bool, ParamType, AuthOption, address, uint48, bytes32, bytes32, uint256)
    {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxConfigurableParams
    function selectOption(bytes32 /* key */, uint256 /* index */ )
        external
        view
        returns (string memory)
    {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxConfigurableParams
    function paramHooks()
        external
        view
        returns (
            address, /* configureHook */
            address, /* augmentHook */
            address /* transferHook */
        )
    {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxConfigurableParams
    function paramHooksLocked() external view returns (bool) {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxConfigurableParams
    function delegateRegistry() external view returns (address) {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxConfigurableParams
    function paramSchemaKeys() external view returns (bytes32[] memory /* keys */ ) {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxConfigurableParams
    function paramSchemaKeysPaged(uint256 /* start */, uint256 /* count */ )
        external
        view
        returns (bytes32[] memory, /* keys */ uint256 /* total */ )
    {
        _delegateParamsRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    // ── composition wiring ──────────────────────────────────────────────────--

    /// @dev The param lifecycle's ownership-change signal — wire from the token's transfer hook.
    ///
    ///      **A transfer hook is a VETO, and that is now said out loud.** Its revert bubbles and the
    ///      transfer fails. This used to swallow the revert and advertise that the lifecycle "must
    ///      never block a transfer", and that promise could not be kept: Solady runs the ERC-721/1155
    ///      receiver acceptance check AFTER this call, so on the `safe*` variants there is real work
    ///      left afterwards, and a hook that is cheap when a wallet estimates gas and expensive when
    ///      the transfer lands pushes it over the limit anyway. Swallowing bought nothing except a
    ///      guarantee that was false in the cases people actually use — a marketplace fill wraps
    ///      `safeTransferFrom` — while making an honest hook's failure invisible.
    ///
    ///      So: no swallow, no gas cap, no assembly. The hook is called plainly, its revert is the
    ///      project's own choice reaching its own collectors, and it is visible instead of silent. A
    ///      creator who wants no such power sets no transfer hook; a creator who wants to prove they
    ///      will never gain it calls `lockParamHooks()` before selling, and a buyer verifies with
    ///      `paramHooks()`. That pair — creator-controlled, and provably freezable — is the honest
    ///      shape. See {IAbxTransferHook}.
    ///
    ///      **It fires on mint and burn too** (`from`/`to == address(0)`), because the hook's whole
    ///      job is to learn about ownership changes and a mint is the first one. As a veto that means
    ///      a reverting hook also stops minting — including through the shared minter, for this
    ///      project only. That is deliberate and consistent: the hook is the creator's contract
    ///      acting on the creator's project. Note it differs from the transfer VALIDATOR, which
    ///      never sees mint or burn precisely so that a policy contract cannot brick issuance; the
    ///      distinction is that a validator is usually a third party's, and a hook is always yours.
    ///
    ///      Returndata is still not read: the call returns nothing, so nothing is decoded.
    function _notifyTransferHook(uint256 tokenId, address from, address to) internal {
        address hook = ConfigurableParamsStorage.layout().transferHook;
        if (hook == address(0)) return;
        // A 721 move is always exactly one token, and `msg.sender` is whoever initiated it.
        IAbxTransferHook(hook).onTokenTransfer(tokenId, from, to, msg.sender, 1);
    }

    /// @dev Enable the extension (announce version) + set the TokenOwner-leg delegation
    ///      resolver: the canonical delegate.xyz v2 registry by default, zero when the project
    ///      opts out. Emits `DelegateRegistrySet` only for the non-default (opt-out) state —
    ///      absence of the event ⇒ the canonical default. Call at initialize.
    function _initConfigurableParams(bool disableTokenOwnerDelegation) internal {
        _setExtensionVersion(ID, VERSION);
        if (disableTokenOwnerDelegation) {
            AbxParamsLib.initDelegateRegistry(address(0));
        } else {
            ConfigurableParamsStorage.layout().delegateRegistry = DEFAULT_DELEGATE_REGISTRY;
        }
    }

    /// @dev Edition variant of {_initConfigurableParams}: there is no `disableTokenOwnerDelegation`
    ///      knob to accept here, because on an ERC-1155 token the TokenOwner-leg delegation check
    ///      is not merely opted out — it is structurally unreachable. `AbxParamsLib`'s owner-leg
    ///      probe (`_isAuthorizedOwnerLeg`) only reaches `_isDelegated` after a successful 721
    ///      `ownerOf` staticcall, which no ERC-1155 token ever satisfies; the edition path falls
    ///      straight to "any holder qualifies" instead. So leaving `delegateRegistry` at its
    ///      un-set storage default (`address(0)`, never written) is both correct (nothing ever
    ///      reads it on this leg) and honest (`delegateRegistry()` reads back `address(0)` — "no
    ///      delegation configured" — rather than a live delegate.xyz address the token can never
    ///      actually consult). Deliberately does NOT call `AbxParamsLib.setDelegateRegistry`
    ///      (unlike the `disableTokenOwnerDelegation = true` path above), because that helper
    ///      unconditionally emits `DelegateRegistrySet` — a config event with nothing configured.
    function _initConfigurableParamsForEdition() internal {
        _setExtensionVersion(ID, VERSION);
    }

    /// @notice ERC-165: the Params chain + this extension's read interface.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(Params)
        returns (bool)
    {
        return Params.supportsInterface(interfaceId)
            || interfaceId == type(IAbxConfigurableParams).interfaceId;
    }
}
