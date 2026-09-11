// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {LibString} from "solady/utils/LibString.sol";

import {TokenURIStorage} from "./TokenURIStorage.sol";
import {TransferValidatorStorage} from "./TransferValidatorStorage.sol";
import {BeaconStorage} from "./BeaconStorage.sol";
import {EditionSupplyStorage} from "./EditionSupplyStorage.sol";
import {Erc1155SupplyStorage} from "./Erc1155SupplyStorage.sol";
import {SeedSourceStorage} from "./SeedSourceStorage.sol";
import {ParamsStorage} from "./ParamsStorage.sol";
import {ConfigurableParamsStorage} from "./ConfigurableParamsStorage.sol";
import {AbxParamsLib} from "./AbxParamsLib.sol";
import {IAbxMetadataRenderer} from "../uri/IAbxMetadataRenderer.sol";
import {IAbxSeedSource} from "../interfaces/IAbxSeedSource.sol";
import {IAbxTransferHook} from "../extensions/configurable-params/IAbxParamHooks.sol";
import {ITransferValidator1155} from "../extensions/creator-token/ITransferValidator1155.sol";
import {
    ITransferValidatorSetTokenType
} from "../extensions/creator-token/ITransferValidatorSetTokenType.sol";

/// @title AbxEditionLib — the ERC-1155 lane's EIP-170 relief valve, as an EXTERNAL library
/// @notice The sibling of {AbxParamsLib} / {AbxCodeLib}: deployed once per chain, `delegatecall`ed by
///         ALL THREE edition tokens — {EditionCode}, {EditionImage} and {OneOfOneEdition}. Storage
///         writes hit the token's own ERC-7201 namespaces; events log from the token — the spine is
///         byte-identical to an inlined implementation.
///
///         This header used to say "ONLY by {EditionCode} (never by {OneOfOneEdition} /
///         {EditionImage}, which must stay lib-free so their factories keep CREATE2-deterministic
///         addresses)". Both halves were wrong, and the second one is why the first was believed:
///         linking a library costs NOTHING in determinism (the library is CREATE2'd at a canonical
///         salt, and linking substitutes its address into already-compiled bytecode), so the two
///         tokens were held library-free for no reason. They are now linked — and because this
///         comment outlived the change, both of their factories were left deploying UNLINKED
///         bytecode in both toolchains. A stale comment asserting an architectural constraint is
///         worse than no comment: it stops the next reader from checking.
/// @dev Access control stays in {EditionCode}'s thin overrides (`onlyOwner`); this library
///      assumes its caller already gated. Event declarations duplicate the mixins' — same
///      signatures, same topics — plus Solady `ERC1155`'s native `URI`, which this library must
///      re-declare itself since it doesn't inherit `ERC1155`.
///
///      **Why these three mixins, and not the shared code-project ones** ({OnChainScript},
///      {Dependencies}, {Params}, {ConfigurableParams}): those already delegatecall
///      {AbxCodeLib}/{AbxParamsLib} directly from the SHARED mixin body, unconditionally, for
///      BOTH standards (721 and 1155) — {SeriesCode} already pays that externalization cost, so
///      composing them onto {EditionCode} adds no NEW inlined bytecode versus the 721 twin.
///      {Uri1155}, {CreatorToken1155}, and {EditionSupply} are different: they're 1155-only mixins
///      whose bodies were originally inlined into each token. All three edition tokens now override
///      the relevant functions to delegate here instead — {EditionCode} because it rides the EIP-170
///      ceiling, the other two because holding them lib-free bought nothing (see the header) and cost
///      them the margin the creator-token fixes needed.
library AbxEditionLib {
    using LibString for uint256;
    using LibString for address;

    // ── event mirrors (identical signatures ⇒ identical topics) ────────────────
    // Uri1155
    event URI(string value, uint256 indexed id); // Solady ERC1155's native event, re-declared
    event MetadataUpdate(uint256 _tokenId); // ERC-4906
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId); // ERC-4906
    event TokenURIBaseSet(string base);
    event TokenURIOverrideSet(uint256 indexed id, string uri);
    event TokenURIRendererSet(address indexed renderer);
    event TokenURIFrozen();
    // CreatorToken1155
    event TransferValidatorUpdated(address oldValidator, address newValidator);
    // AbxBeaconCore's announce, re-declared: this library writes the beacon version for the
    // creator-token extension, which the mixin's `private _setExtensionVersion` is unreachable for.
    event AbxExtensionVersionSet(bytes32 indexed extensionId, uint16 version);
    // EditionSupply
    event MaxSupplyUpdated(uint256 indexed id, uint256 cap);
    event DefaultMaxSupplySet(uint256 cap);

    /// @dev Mirrors {CreatorToken1155}'s own `ID` / `VERSION` — the same permanent extension id
    ///      (`keccak256("abx.extension.creator-token")`) and implemented version, restated because
    ///      an external library cannot read the mixin's `private` constants.
    bytes32 private constant CREATOR_TOKEN_ID =
        0x0839e7ed7fc1f5db3f253851d61b10f852045c5520c2936138b121b73e7e27c0;
    uint16 private constant CREATOR_TOKEN_VERSION = 1;

    error TokenURIConfigLocked();
    error InvalidTransferValidator();
    error NotCreatorToken();
    error MaxSupplyIncreaseForbidden();
    error MaxSupplyBelowFloor();
    error EditionSupplyReached();

    // ── Uri1155: the uri() precedence ladder + string composition + mutation ops ──────────────

    /// @dev Identical precedence ladder to {Uri1155-uri}: renderer → per-id override → derived
    ///      base → "". `address(this)` is `EditionCode` under delegatecall either way.
    function uri(uint256 id) public view returns (string memory) {
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        if (l.renderer != address(0)) {
            return IAbxMetadataRenderer(l.renderer).tokenURI(address(this), id);
        }
        string memory ov = l.tokenOverride[id];
        if (bytes(ov).length != 0) return ov;
        if (bytes(l.base).length == 0) return "";
        return _composeUri(l.base, id);
    }

    /// @dev Identical to {Uri1155-_composeUri}: `{base}/{chainId}/{address}/{id}`.
    function _composeUri(string memory base, uint256 id) private view returns (string memory) {
        return string.concat(
            base,
            "/",
            block.chainid.toString(),
            "/",
            address(this).toHexString(),
            "/",
            id.toString()
        );
    }

    function setTokenURIBase(string calldata base) public {
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        if (l.locked) revert TokenURIConfigLocked();
        l.base = base;
        emit TokenURIBaseSet(base);
        // Every id's `uri()` just moved, so the collection needs a refresh signal. ERC-1155's native
        // `URI` has no range form and looping it over an open id space is the thing this lane
        // deliberately refuses — but ERC-4906's range form is O(1), these tokens advertise
        // `0x49064906`, and OpenSea's own `ERC1155SeaDrop` emits exactly this on an ERC-1155. The
        // earlier reasoning ruled out the loop and then over-applied that to the range form too,
        // leaving a collection-wide re-point with no refresh signal at all.
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function setTokenURIOverride(uint256 id, string calldata uri_) public {
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        if (l.locked) revert TokenURIConfigLocked();
        l.tokenOverride[id] = uri_;
        emit TokenURIOverrideSet(id, uri_);
        emit MetadataUpdate(id); // ERC-4906: exactly the one id that changed
        // Native `URI` carries the resolved value, so emit it only when resolving is cheap. With a
        // renderer configured, `uri(id)` renders the WHOLE document (a base64 `data:` URI that can
        // run to hundreds of KB) — at 8 gas per byte of log data that can put an ordinary owner
        // write past the block gas limit. A renderer also outranks an override in the precedence
        // ladder, so the value emitted would not even reflect this write.
        if (l.renderer == address(0)) emit URI(uri(id), id);
    }

    function setTokenURIRenderer(address renderer) public {
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        if (l.locked) revert TokenURIConfigLocked();
        l.renderer = renderer;
        emit TokenURIRendererSet(renderer);
        // Flips the whole collection between an off-chain pointer and an on-chain document.
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function lockTokenURI() public {
        TokenURIStorage.layout().locked = true;
        emit TokenURIFrozen();
    }

    /// @dev Identical to {Uri1155-pingURI} — owner-only (the mixin gates it), caller-chunked. Emits
    ///      `MetadataUpdate(id)` always, and the native `URI` only when no on-chain renderer is
    ///      configured: with one, `uri(id)` renders the whole document into log data.
    function pingURI(uint256[] calldata ids) public {
        // Both behaviours below were added to {Uri1155-pingURI} and NOT ported here, where they
        // actually run — all three edition tokens override the mixin to delegate into this library,
        // so for a while no edition emitted the ERC-4906 ping at all and every one of them rendered
        // the whole document into log data.
        bool onChain = TokenURIStorage.layout().renderer != address(0);
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            emit MetadataUpdate(id);
            // Native `URI` carries the resolved value. With a renderer configured that means
            // rendering the entire document per id: measured at 7.39M gas for ONE id on a 20 KB
            // inline-SVG edition, and past a block for a 100 KB code project — which would make the
            // documented chunked re-index workflow unusable on exactly the projects needing it.
            if (onChain) continue;
            emit URI(uri(id), id);
        }
    }

    // ── CreatorToken1155: enrollment, re-point, and the per-transfer validator loop ────────────

    /// @dev Identical to {CreatorToken1155-_initCreatorToken}, beacon announce included.
    function initCreatorToken(address validator) public {
        if (validator == address(0)) return;
        _requireHasCode(validator);
        TransferValidatorStorage.Layout storage l = TransferValidatorStorage.layout();
        l.enrolled = true;
        // Announce the extension on the beacon, exactly as {CreatorToken1155-_initCreatorToken}
        // does. This used to be missing here — the mixin reaches its own `_setExtensionVersion`,
        // which an external library cannot — so an enrolled `EditionCode` reported
        // `extensionVersion(creator-token) == 0` and never emitted `AbxExtensionVersionSet`, while
        // ERC-165 and `getTransferValidator()` both said enrolled and the validator was actively
        // blocking transfers. Three specs name the beacon version as *the* reconstruction signal
        // for enrollment, so an indexer had no way to see it. Written directly against
        // `BeaconStorage` (the same state the mixin's helper writes) and evented identically.
        BeaconStorage.layout().extensionVersion[CREATOR_TOKEN_ID] = CREATOR_TOKEN_VERSION;
        emit AbxExtensionVersionSet(CREATOR_TOKEN_ID, CREATOR_TOKEN_VERSION);
        _setValidator(l, validator);
        _registerTokenType(validator);
    }

    /// @dev Identical to {CreatorToken1155-setTransferValidator} (minus the `onlyOwner` gate,
    ///      which stays on {EditionCode}'s override).
    function setTransferValidator(address validator) public {
        TransferValidatorStorage.Layout storage l = TransferValidatorStorage.layout();
        if (!l.enrolled) revert NotCreatorToken();
        if (validator != address(0)) _requireHasCode(validator);
        _setValidator(l, validator);
        _registerTokenType(validator);
    }

    /// @dev Identical to {CreatorToken1155-_validateTransfer1155}.
    function validateTransfer1155(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts
    ) public {
        address validator = TransferValidatorStorage.layout().validator;
        if (validator == address(0)) return;
        if (from == address(0) || to == address(0)) return;
        if (msg.sender == validator) return;
        for (uint256 i; i < ids.length; ++i) {
            // A zero-amount entry moves nothing, so there is no transfer for a policy to judge.
            // Skipping it saves an external call per entry and keeps the validator's view of this
            // collection free of events that did not happen — the same reasoning as the transfer
            // hook's zero skip, which closed a permissionless spoof.
            if (amounts[i] == 0) continue;
            ITransferValidator1155(validator)
                .validateTransfer(msg.sender, from, to, ids[i], amounts[i]);
        }
    }

    /// @dev Identical to {CreatorToken1155-_requireHasCode} — see {CreatorToken-_requireHasCode}
    ///      for the live-probe evidence and why an ERC-165 gate is not viable.
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

    function _setValidator(TransferValidatorStorage.Layout storage l, address validator) private {
        address old = l.validator;
        // No-change writes are a no-op, not an event. Both {CreatorToken} and {CreatorToken1155}
        // carry this line, and this library — which is the code all three edition tokens ACTUALLY
        // run — was missing it, so the 721 lane emitted nothing under the scenario the 1155 lane
        // emitted unboundedly: once a collection is ownerless the suspend path is permissionless, so
        // a stranger could spam `TransferValidatorUpdated(0,0)` and make the log history unusable.
        // A third copy of a body is a third place for a fix to not land.
        if (old == validator) return;
        l.validator = validator;
        emit TransferValidatorUpdated(old, validator);
    }

    /// @dev Identical to {CreatorToken1155}'s own `TOKEN_TYPE_ERC1155` — see its class-level dev
    ///      note for the PermitC/creator-token-standards provenance of the `uint16` typing.
    uint16 private constant TOKEN_TYPE_ERC1155 = 1155;

    function _registerTokenType(address validator) private {
        if (validator == address(0)) return;
        // forge-lint: disable-next-line(unchecked-call)
        try ITransferValidatorSetTokenType(validator)
            .setTokenTypeOfCollection(address(this), TOKEN_TYPE_ERC1155) {}
            catch {}
    }

    // ── EditionSupply: setMaxSupply + the mint-time cap guard ──────────────────────────────────

    /// @dev Identical to {EditionSupply-setMaxSupply} (minus the `onlyOwner` gate).
    function setMaxSupply(uint256 id, uint256 cap) public {
        EditionSupplyStorage.Layout storage l = EditionSupplyStorage.layout();
        if (l.overridden[id]) {
            if (cap > l.capOverride[id]) revert MaxSupplyIncreaseForbidden();
        } else if (l.defaultCap != 0 && cap > l.defaultCap) {
            revert MaxSupplyIncreaseForbidden();
        }
        if (cap < Erc1155SupplyStorage.layout().totalSupply[id]) revert MaxSupplyBelowFloor();
        l.capOverride[id] = cap;
        l.overridden[id] = true;
        emit MaxSupplyUpdated(id, cap);
    }

    /// @dev Identical to {EditionSupply-_requireWithinEditionCap}.
    function requireWithinEditionCap(uint256 id, uint256 amount) public view {
        EditionSupplyStorage.Layout storage l = EditionSupplyStorage.layout();
        if (!l.overridden[id] && l.defaultCap == 0) return;
        uint256 cap = l.overridden[id] ? l.capOverride[id] : l.defaultCap;
        if (Erc1155SupplyStorage.layout().totalSupply[id] + amount > cap) {
            revert EditionSupplyReached();
        }
    }

    // ── EditionCode's mint-path bookkeeping: id watermark + first-mint seed draw ───────────────

    /// @dev Identical to the id-watermark bump + seed-draw slice of {EditionCode-_mintEditionId}
    ///      — everything BETWEEN the guards and the actual `_mint`, which stays on the token
    ///      itself (Solady's `_mint` is `internal`, invisible to an external library). Reads
    ///      {SeedSourceStorage} / checks {ParamsStorage}'s `isSet` directly (the same plain
    ///      storage reads {SeedSourceExtension-_drawSeed} / {Params-_tokenParamIsSet} do) rather
    ///      than calling back into the token's own internal functions, which an external library
    ///      cannot reach; persists via {AbxParamsLib.setTokenParam} — the SAME call
    ///      {Params-_setTokenParam} already makes, so the spine (including the ERC-4906
    ///      `MetadataUpdate` {Params}/{AbxParamsLib} already emit on every token param write,
    ///      1155 or 721) is unchanged, just relocated.
    function advanceWatermarkAndDrawSeed(uint256 id, address to, bytes32 seedKey) public {
        Erc1155SupplyStorage.Layout storage supply = Erc1155SupplyStorage.layout();
        if (id >= supply.idWatermark) supply.idWatermark = id + 1; // extend the no-stranding floor
        if (supply.totalSupply[id] == 0 && !ParamsStorage.layout().tokenParams[id][seedKey].isSet) {
            address source = SeedSourceStorage.layout().seedSource;
            if (source != address(0)) {
                // Same latch, same reason, before the same external call — see
                // {AbxParamsLib-latchSeedAssignment}. The edition lane had the identical ordering.
                ParamsStorage.layout().anySeedAssigned = true;
                bytes32 value = IAbxSeedSource(source).seed(id, to);
                AbxParamsLib.setTokenParam(id, seedKey, value, false, source);
            }
        }
    }

    /// @dev Identical semantics to {ConfigurableParams-_notifyTransferHook}: the hook is a VETO, its
    ///      revert bubbles and fails the whole batch, and the hook set is freezable with
    ///      `lockParamHooks()`. No swallow, no gas budget — see that function for why the old
    ///      "never blocks a transfer" promise was unkeepable and why saying so plainly is better.
    function notifyTransferHookForIds(
        uint256[] memory ids,
        uint256[] memory amounts,
        address from,
        address to,
        address operator
    ) public {
        address hook = ConfigurableParamsStorage.layout().transferHook;
        if (hook == address(0)) return;
        // Nothing moved ⇒ nothing to notify. Both skips close a permissionless spoof an independent
        // Adversarial testing reproduced: Solady allows `safeTransferFrom(from, to, id, 0, "")`
        // from any caller
        // (zero is not greater than a zero balance), so a stranger holding no copy could fire the
        // lifecycle for any id, and a hook storing transfer-derived state would rewrite params
        // shared by every real holder. A self-transfer is the same shape with a real balance: the
        // ownership set is unchanged, so the lifecycle has nothing to report.
        //
        // The hook also receives `operator` and `amount` now and can apply its own policy — but the
        // token refusing to make the call at all is what makes a NAIVE hook unspoofable, and most
        // hooks will be naive.
        if (from == to) return;
        for (uint256 i; i < ids.length; ++i) {
            if (amounts[i] == 0) continue;
            IAbxTransferHook(hook).onTokenTransfer(ids[i], from, to, operator, amounts[i]);
        }
    }
}
