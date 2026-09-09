// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {ERC1155} from "solady/tokens/ERC1155.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LibString} from "solady/utils/LibString.sol";

import {TokenURIStorage} from "../../libraries/TokenURIStorage.sol";
import {IAbxMetadataRenderer} from "../IAbxMetadataRenderer.sol";
import {IERC4906} from "../../interfaces/IERC4906.sol";
import {AbxEditionLib} from "../../libraries/AbxEditionLib.sol";

/// @title Uri1155 — the general, cardinality-neutral ERC-1155 `uri()` strategy
/// @notice The 1155 sibling of `TokenURI`: resolves `uri(id)` by the SAME fixed precedence —
///         1. an on-chain `renderer` if one is configured (assembles the JSON on-chain);
///         2. else a per-id override (`tokenOverride[id]`) if set — a fixed locator;
///         3. else a pointer DERIVED on-chain from a stored `base` and the protocol path grammar
///            `{base}/{chainId}/{address}/{id}`;
///         4. else the empty string.
///         Reuses `TokenURIStorage` verbatim (a plain `uint256`-keyed library with no ERC-721
///         coupling — its `id` key works identically for a 721 token id or a 1155 id). The owner
///         can re-point the base, set/clear overrides, toggle the renderer, and `lockTokenURI`
///         to freeze all of it forever — same surface as `TokenURI`, one scope down (per id, not
///         per token, though for 1155 those coincide).
/// @dev **Design decision — no existence gate.** `TokenURI` reverts `NonexistentToken` for an
///      unminted 721 id (via ERC-721's `_exists`). This mixin deliberately does NOT gate on
///      existence: ERC-1155 has no native "existence" concept the way 721 does (a fresh id with
///      zero balance is not an error state — Solady's own `uri(uint256)` carries no existence
///      check either), and gating on `totalSupply(id) > 0` would couple this URI-resolution mixin
///      to the opt-in `EditionSupply` extension, which every edition token in this launch happens
///      to compose but which this mixin shouldn't assume. Resolving metadata for an id that never
///      receives a mint simply returns whatever the precedence ladder resolves to (often the
///      derived pointer, which a resolver can 404 on its own terms) — a deliberate, documented
///      deviation from the 721 twin, reported as such rather than silently matched.
///
///      **ERC-4906 rides here too, alongside the native `URI`.** The standard is nominally a 721
///      extension, but the range form is what the ecosystem actually consumes for ERC-1155 — 
///      OpenSea's own `ERC1155SeaDrop` emits `BatchMetadataUpdate(0, type(uint256).max)` on an
///      ERC-1155 — and this repo's `IERC4906` is event-only (it does NOT inherit `IERC721`), so the
///      id `0x49064906` is a bespoke marker constant rather than a selector XOR implying 721
///      support. Emitting and advertising it is therefore both honest and useful, and it is what
///      lets `OnChainMetadata` emit ONE refresh signal both lanes understand instead of paying for
///      a per-lane virtual hook on all six tokens.
///
///      The native `URI` signal is kept as well, and its shape is deliberately NOT a copy of
///      `TokenURI`'s 721 pattern:
///        - `setTokenURIOverride(id, ...)` — ONE id changed → one `URI(uri(id), id)`, automatic,
///          O(1) (trivial — exactly one id can ever be affected by a per-id override).
///        - `setTokenURIBase` / `setTokenURIRenderer` — contract-wide (every id without an
///          override may have changed). `TokenURI`'s 721 twin expresses this as a SINGLE O(1)
///          `BatchMetadataUpdate(0, type(uint256).max)` event, because ERC-4906 has a *range*
///          signal. **ERC-1155's native `URI` event has no range variant** — it is strictly
///          per-id — so reproducing "every id may have changed" as one `URI` per id would mean
///          looping over the WHOLE id space in the mutating call itself. For a large edition
///          (thousands of ids) that loop is unbounded and can never fit a block gas limit — an
///          owner operation that can literally never succeed is a trap, not a feature, so this
///          mixin does NOT attempt it automatically. `setTokenURIBase`/`setTokenURIRenderer` emit
///          their Register-2 config event (`TokenURIBaseSet`/`TokenURIRendererSet`) AND the O(1)
///          ERC-4906 range form. The earlier rule here was "config event only", which correctly
///          ruled out LOOPING native `URI` over an open id space and then wrongly extended that to
///          the range form too — leaving a collection-wide re-point with no refresh signal at all —
///          per EIP-1155's own qualifier ("A contract MUST emit the `URI` event if it changes...
///          in a way that can be expressed with the `URI` event"), an unbounded re-point can't be
///          expressed that way, so it isn't looped. That Register-2 event IS the re-point signal
///          for an ABX-aware indexer; a marketplace wanting the native re-emission too gets it via
///          {pingURI}, called in caller-sized chunks after the fact — an explicit, boundable op
///          instead of an implicit, unboundable one.
///        - `lockTokenURI()` — `TokenURI`'s 721 twin emits NO 4906 ping for this op either; this
///          mixin matches: no `URI` companion, just `TokenURIFrozen()`.
///      Storage is ERC-7201 (`TokenURIStorage`, shared verbatim with `TokenURI`).
abstract contract Uri1155 is ERC1155, Ownable, IERC4906 {
    using LibString for uint256;
    using LibString for address;

    error TokenURIConfigLocked();

    /// @notice The resolver base was re-pointed (every id without an override may have changed).
    event TokenURIBaseSet(string base);
    /// @notice A per-id full-URI override was set (empty `uri` clears it).
    event TokenURIOverrideSet(uint256 indexed id, string uri);
    /// @notice The on-chain metadata renderer was set (zero ⇒ resolve off-chain again).
    event TokenURIRendererSet(address indexed renderer);
    /// @notice The token-URI config (base + renderer + overrides) was frozen forever.
    event TokenURIFrozen();

    /// @dev Set the URI config at initialize (no event; the mint's `TransferSingle` is the signal).
    function _initTokenURI(string calldata base, address renderer) internal {
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        l.base = base;
        l.renderer = renderer;
    }

    /// @notice The id's metadata URI, by precedence: renderer → per-id override → derived base.
    /// @dev **One body, in {AbxEditionLib}, and this is a raw-calldata passthrough rather than a
    ///      typed shell** — same shape and same reason as {Params-_delegateParamsRead}: decoding a
    ///      dynamic `string` return here and re-encoding it costs more than the extracted body saves.
    ///
    ///      The ladder used to live here AND in the library, with all three edition tokens overriding
    ///      to reach the library copy — so this mixin's version was dead, and each token carried its
    ///      own ~40-line copy of the assembly below. Three copies of a passthrough, in front of a
    ///      body nothing called. Not `virtual`: an override is how the split came back last time.
    function uri(uint256 /* id */ ) public view override returns (string memory) {
        _delegateEditionUriRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @dev See {Params-_delegateParamsRead} for why the pointer cast exists (it launders the
    ///      mutability checker's complaint about a raw `delegatecall` in a view). Never returns.
    function _delegateEditionUriRead() private view {
        function() internal fn = _delegateEditionUriReadRaw;
        function() internal view viewFn;
        assembly {
            viewFn := fn
        }
        viewFn();
    }

    /// @dev The raw forward. Non-view only because assembly `delegatecall` is always flagged.
    function _delegateEditionUriReadRaw() private {
        address lib = address(AbxEditionLib);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), lib, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    /// @notice Owner re-points the resolver base (affects every id without an override). Emits
    ///         ONLY `TokenURIBaseSet` — the contract-wide re-point signal; see the class-level
    ///         dev note on why this does not loop-emit native `URI` for every id, and use
    ///         {pingURI} afterward if that re-emission is wanted.
    function setTokenURIBase(string calldata base) external virtual onlyOwner {
        // ONE implementation. This body used to live here AND in {AbxEditionLib}, with every
        // concrete edition token overriding to pick the library copy — so the mixin's copy was
        // unreachable, and three separate fixes landed in it instead of in the code that runs.
        // The mixin now delegates, and the tokens carry no override at all.
        AbxEditionLib.setTokenURIBase(base);
    }

    /// @notice Owner sets (or clears, with an empty string) a per-id full-URI override.
    function setTokenURIOverride(uint256 id, string calldata uri_) external virtual onlyOwner {
        // ONE implementation. This body used to live here AND in {AbxEditionLib}, with every
        // concrete edition token overriding to pick the library copy — so the mixin's copy was
        // unreachable, and three separate fixes landed in it instead of in the code that runs.
        // The mixin now delegates, and the tokens carry no override at all.
        AbxEditionLib.setTokenURIOverride(id, uri_);
    }

    /// @notice Owner sets the on-chain renderer (non-zero ⇒ resolve on-chain; zero ⇒ off-chain).
    ///         Emits ONLY `TokenURIRendererSet` — see {setTokenURIBase}'s note; use {pingURI}
    ///         afterward for the native `URI` re-emission.
    function setTokenURIRenderer(address renderer) external virtual onlyOwner {
        // ONE implementation. This body used to live here AND in {AbxEditionLib}, with every
        // concrete edition token overriding to pick the library copy — so the mixin's copy was
        // unreachable, and three separate fixes landed in it instead of in the code that runs.
        // The mixin now delegates, and the tokens carry no override at all.
        AbxEditionLib.setTokenURIRenderer(renderer);
    }

    /// @notice Owner freezes the token-URI config (base + renderer + all overrides) forever.
    ///         With the id's fields also locked, the resolved metadata is provably immutable.
    function lockTokenURI() external virtual onlyOwner {
        // ONE implementation. This body used to live here AND in {AbxEditionLib}, with every
        // concrete edition token overriding to pick the library copy — so the mixin's copy was
        // unreachable, and three separate fixes landed in it instead of in the code that runs.
        // The mixin now delegates, and the tokens carry no override at all.
        AbxEditionLib.lockTokenURI();
    }

    /// @notice The configured resolver base (empty ⇒ none).
    function tokenURIBase() external view returns (string memory) {
        return TokenURIStorage.layout().base;
    }

    /// @notice The per-id override for `id` (empty ⇒ none; the derived base path is used).
    function tokenURIOverride(uint256 id) external view returns (string memory) {
        return TokenURIStorage.layout().tokenOverride[id];
    }

    /// @notice The configured on-chain renderer (zero ⇒ resolving off-chain).
    function tokenURIRenderer() external view returns (address) {
        return TokenURIStorage.layout().renderer;
    }

    /// @notice Whether the token-URI config is frozen.
    function tokenURILocked() external view returns (bool) {
        return TokenURIStorage.layout().locked;
    }

    /// @notice Owner-only, chunkable re-emission helper: emits `MetadataUpdate(id)` for each id in
    ///         `ids` — plus the native `URI(uri(id), id)` when no on-chain renderer is configured —
    ///         in the CALLER's chosen batch.
    /// @dev It was permissionless, on the reasoning that it emits only already-public truth and the
    ///      gas is the caller's to spend. That reasoning misses who pays the OTHER side: with an
    ///      on-chain renderer, the caller pays event gas while an event-driven indexer may perform
    ///      an expensive `uri(id)` per id, for arbitrary, duplicate, or nonexistent ids it did not
    ///      choose. Owner-only matches what the verb is actually for — an owner's follow-up to a
    ///      re-point — and removes the asymmetry at no cost to anyone who needs it.
    /// @dev The intended use is operational, not automatic: after a contract-wide re-point
    ///      (`setTokenURIBase`/`setTokenURIRenderer` emit the ERC-4906 range form; see the
    ///      class-level dev note), an operator who wants marketplaces/indexers
    ///      that only honor the native `URI` event to re-index calls this in chunks sized to fit
    ///      comfortably under a block gas limit, covering as much or as little of the id space as
    ///      they choose. No id-space introspection is attempted here — the caller names the ids.
    /// @dev Owner-only, which matches what it is FOR: the follow-up an owner runs after re-pointing
    ///      a URI. It was permissionless, and with an on-chain renderer that is asymmetric — the
    ///      caller pays event gas while an event-driven indexer may perform an expensive `uri(id)`
    ///      per id, for arbitrary, duplicate, or nonexistent ids. Robust indexers coalesce refreshes
    ///      anyway; removing the primitive costs nothing an owner needs.
    function pingURI(uint256[] calldata ids) external virtual onlyOwner {
        // ONE implementation. This body used to live here AND in {AbxEditionLib}, with every
        // concrete edition token overriding to pick the library copy — so the mixin's copy was
        // unreachable, and three separate fixes landed in it instead of in the code that runs.
        // The mixin now delegates, and the tokens carry no override at all.
        AbxEditionLib.pingURI(ids);
    }
}
