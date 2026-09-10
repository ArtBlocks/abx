// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {SSTORE2} from "solady/utils/SSTORE2.sol";
import {LibString} from "solady/utils/LibString.sol";
import {LibBytes} from "solady/utils/LibBytes.sol";
import {Base64} from "solady/utils/Base64.sol";

import {IAbxFieldRenderer} from "../uri/IAbxFieldRenderer.sol";
import {IAbxOnChainScript} from "../extensions/onchain-script/IAbxOnChainScript.sol";
import {IAbxDependencies} from "../extensions/dependencies/IAbxDependencies.sol";
import {IAbxOnChainMetadata} from "../extensions/onchain-metadata/IAbxOnChainMetadata.sol";
import {IAbxParams} from "../extensions/params/IAbxParams.sol";
import {IAbxConfigurableParams} from
    "../extensions/configurable-params/IAbxConfigurableParams.sol";
import {IDependencyRegistryV0} from "../interfaces/IDependencyRegistryV0.sol";
import {TokenDataLib} from "../libraries/TokenDataLib.sol";
import {DynamicBuffer} from "../libraries/DynamicBuffer.sol";

/// @title AbxGenerator — the canonical on-chain generator (the `animation` field renderer)
/// @notice One per-chain singleton serving BOTH code-custody modes:
///
///         - **Template branch** (script chunks present — wins when both): assembles the full
///           HTML document from chain, byte-shaped like the off-chain resolver's reference
///           generator (`packages/token-api/src/code.ts` `assembleGeneratorDocument`):
///           `window.abxTokenData` (via {TokenDataLib}) → `abx.js` → dependencies in order →
///           the script chunks. Registry deps with on-chain bytes ride VERBATIM as inert
///           `text/javascript+gzip` data-URI tags (chunks are stored pre-gzip'd + pre-base64'd
///           — zero transcoding, the AB/scripty pattern) + one gunzip bootstrap tag after the
///           last gzip tag; CDN entries emit `<script src>` (the normal production path);
///           unresolvable refs emit an `abx:unresolved` HTML comment marker naming the
///           `name` + `version` ref — NEVER a revert.
///         - **Directory branch** (`code` collection field present): emits the parameterized
///           locator `{gateway}{root}/index.html?abx=<base64url(tokenData)>` — no-server, but
///           the payload rides a URL (the ~8KB budget; see {onChainStatus}).
///
///         The runtime rides with the generator: `abx.js` and the gunzip bootstrap are baked
///         at deployment (SSTORE2) — a chain-complete document depends on nothing this
///         contract can't reach by staticcall.
///
/// @dev **render() never reverts** for any token state — a `tokenURI` that reverts is
///      strictly worse than one that degrades honestly. All registry reads and token probes
///      are guarded (external self-call try/catch); total failure degrades to an HTML comment
///      marker. **Piecewise getters mirror every intermediate** ({tokenDataJson},
///      {dependencyTag}, {document}, {abxJs}, {gunzipScript}, {registryScriptChunk}) — RPC
///      nodes cap `eth_call` gas, and the honest escape hatch is client-side assembly from
///      the pieces.
///
///      **tokenData scope — on-chain enumeration:** the params store lists its own keys
///      (`IAbxParams.contractParamKeys` / `tokenParamKeys`), so the singleton reads a
///      project's whole param surface from chain — no convention, no off-chain hint, nothing
///      for deploy tooling to keep in sync. Both scopes are enumerated and unioned (a key set
///      at both appears ONCE), the reserved coordinates (`chainId`, `contractAddress`,
///      `tokenId`, `seed`) are skipped, each remaining key resolves token-scope-wins and
///      decodes canonically per its Configurable Params schema (or the schema-less rule:
///      printable-ASCII literals as text, anything else full bytes32 hex, data-backed blobs
///      base64 — the SDK serializer's exact behavior), and ALL keys serialize sorted
///      lexicographically — the canonical (hashed) form. The enumeration reads are guarded
///      ({paramKeysOf}): a token implementation predating the key getters — or a hostile one
///      — degrades to the reserved coordinates + `seed` + the augment hook's entries only.
///      The augment hook remains the read-time compute seam either way (its entries append
///      last, augment-wins).
///
///      Assembly patterns (measure-then-allocate-once, in-place base64, verbatim gzip'd dependency
///      carriage + gunzip bootstrap) are adapted from Art Blocks' GenArt721GeneratorV0 and
///      scripty.sol V2.
contract AbxGenerator is IAbxFieldRenderer {
    // ── branch ids (the {onChainStatus} vocabulary) ─────────────────────────--
    uint8 public constant BRANCH_NONE = 0;
    uint8 public constant BRANCH_TEMPLATE = 1;
    uint8 public constant BRANCH_DIRECTORY = 2;

    /// @notice The URL budget for the directory branch's `?abx=` payload — gateway
    ///         front-ends commonly cap request lines near 8KB (the spec's budget).
    uint256 public constant URL_BUDGET_BYTES = 8192;

    /// @notice The most dependencies either read surface will walk for one token.
    /// @dev A bound on an ALLOCATION driven by a value the token controls, not a gas check. The
    ///      count comes from `dependencyCount()`, so a token reporting `type(uint24).max` made
    ///      `new string[](n)` — and the loop after it — die, which took {onChainStatus} down even
    ///      though {render} degrades honestly around it. That is the piecewise escape hatch the whole
    ///      design leans on, so it must not be the thing that breaks first. Real projects carry a
    ///      handful of dependencies; a project past this ceiling could not be rendered at any count,
    ///      so truncating and saying so beats reverting and saying nothing.
    uint256 public constant MAX_DEPENDENCIES = 256;

    /// @notice The most script chunks this generator will read for one script — the project's own
    ///         and a registry dependency's alike.
    /// @dev Dependency COUNT was bounded and chunk count was not, so an array was allocated straight
    ///      from a project's `scriptChunkCount()` or a registry-reported `uint24 scriptCount`. A
    ///      malformed default registry could force an allocation failure BEFORE the guarded
    ///      per-chunk reads, degrading the whole document to `abx:render-failed` rather than to one
    ///      unresolved dependency. Bounding before allocation keeps a bad neighbour local. 4,096
    ///      chunks is far past any real script (24 KB each ⇒ ~98 MB).
    uint256 public constant MAX_SCRIPT_CHUNKS = 4096;

    // ── wiring (baked at deployment; the generator is a per-chain singleton) ──
    /// @notice The fallback dependency registry (AB's DependencyRegistryV0 on canonical
    ///         chains) — used when the collection's `dependencyRegistry()` is unset.
    address public immutable defaultDependencyRegistry;
    /// @notice SSTORE2 pointer to `abx.js` (the runtime companion, inlined into documents).
    address public immutable abxJsPointer;
    /// @notice SSTORE2 pointer to `gunzipScripts-0.0.1.js` (the fflate bootstrap that
    ///         inflates the inert gzip data-URI tags in the browser).
    address public immutable gunzipScriptPointer;

    /// @notice Directory-branch gateway prefix for `ipfs` code roots (e.g.
    ///         "https://ipfs.io/ipfs/"); the collection's `abx_gateway_ipfs` field overrides.
    string public defaultIpfsGateway;
    /// @notice Directory-branch gateway prefix for `arweave` code roots (e.g.
    ///         "https://arweave.net/"); the collection's `abx_gateway_arweave` field overrides.
    string public defaultArweaveGateway;

    // ── field / representation / param tags ─────────────────────────────────--
    bytes32 private constant F_ANIMATION_URL = "animation_url";
    bytes32 private constant F_ANIMATION = "animation";
    bytes32 private constant F_CODE = "code";
    bytes32 private constant F_GATEWAY_IPFS = "abx_gateway_ipfs";
    bytes32 private constant F_GATEWAY_ARWEAVE = "abx_gateway_arweave";
    bytes32 private constant R_INLINE = "inline";
    bytes32 private constant K_SEED = "seed";
    bytes32 private constant R_URL = "url";
    bytes32 private constant R_IPFS = "ipfs";
    bytes32 private constant R_ARWEAVE = "arweave";

    // ── dep-tag classes (internal) ──────────────────────────────────────────--
    uint8 private constant CLASS_UNRESOLVED = 0;
    uint8 private constant CLASS_GZIP = 1; // registry on-chain bytes → inert gzip data-URI tag
    uint8 private constant CLASS_INLINE = 2; // OnChain-resolution SSTORE2 ref → plain <script>
    uint8 private constant CLASS_CDN = 3;

    // ── document shell (byte-identical to the resolver's reference generator) ──
    string private constant SHELL_HEAD =
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<style>html,body{margin:0;padding:0;overflow:hidden}canvas{display:block}</style>\n<script>window.abxTokenData=";
    string private constant SHELL_ABXJS_OPEN = ";</script>\n<script>";
    string private constant SHELL_ABXJS_CLOSE = "</script>";
    string private constant SHELL_BODY = "\n</head><body>\n<script>\n";
    string private constant SHELL_TAIL = "\n</script>\n</body></html>";

    // ── tag shells (the AB/scripty carriage) ────────────────────────────────--
    string private constant GZIP_TAG_OPEN =
        "<script type=\"text/javascript+gzip\" src=\"data:text/javascript;base64,";
    string private constant B64_TAG_OPEN = "<script src=\"data:text/javascript;base64,";
    string private constant DATA_TAG_CLOSE = "\"></script>";

    // ── degradation markers (render() never reverts) ────────────────────────--
    string private constant MARKER_NO_CODE = "<!-- abx:no-code -->";
    string private constant MARKER_RENDER_FAILED = "<!-- abx:render-failed -->";
    string private constant MARKER_UNRESOLVED_CODE = "<!-- abx:unresolved code -->";

    // ── content types ───────────────────────────────────────────────────────--
    string private constant CT_HTML = "text/html";
    // The directory branch's output is a LOCATOR, not content — text/uri-list (RFC 2483) IS
    // the MIME type for "this payload is a URI". The canonical {AbxMetadataRenderer} lands
    // text/uri-list renderer output VERBATIM as the field's value (never data-wrapped), so
    // `animation_url = <the url>` reaches marketplaces dereferenceable.
    string private constant CT_URI_LIST = "text/uri-list";
    string private constant CT_PLAIN = "text/plain";

    /// @param defaultDependencyRegistry_ per-chain fallback registry (AB's; zero = none).
    /// @param abxJsPointer_ SSTORE2 pointer holding the exact `abx.js` bytes.
    /// @param gunzipScriptPointer_ SSTORE2 pointer holding `gunzipScripts-0.0.1.js`.
    /// @param defaultIpfsGateway_ full ipfs prefix incl. trailing path (e.g. "https://ipfs.io/ipfs/").
    /// @param defaultArweaveGateway_ full arweave prefix (e.g. "https://arweave.net/").
    constructor(
        address defaultDependencyRegistry_,
        address abxJsPointer_,
        address gunzipScriptPointer_,
        string memory defaultIpfsGateway_,
        string memory defaultArweaveGateway_
    ) {
        defaultDependencyRegistry = defaultDependencyRegistry_;
        abxJsPointer = abxJsPointer_;
        gunzipScriptPointer = gunzipScriptPointer_;
        defaultIpfsGateway = defaultIpfsGateway_;
        defaultArweaveGateway = defaultArweaveGateway_;
    }

    // ── the field renderer (IAbxFieldRenderer) ──────────────────────────────--

    /// @inheritdoc IAbxFieldRenderer
    /// @dev Serves the `animation_url` field (accepts the `animation` alias). Template →
    ///      `("text/html", document)`; the metadata renderer wraps it as
    ///      `data:text/html;base64`. Directory → `("text/uri-list", url)` — see {CT_URI_LIST}.
    ///      NEVER reverts: any assembly failure returns an HTML comment marker instead.
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        if (field != F_ANIMATION_URL && field != F_ANIMATION) return (CT_PLAIN, bytes(""));
        uint8 branch = _branch(token);
        if (branch == BRANCH_NONE) return (CT_HTML, bytes(MARKER_NO_CODE));
        try this.document(token, tokenId) returns (string memory out) {
            if (branch == BRANCH_DIRECTORY) {
                if (bytes(out).length == 0) return (CT_HTML, bytes(MARKER_UNRESOLVED_CODE));
                return (CT_URI_LIST, bytes(out));
            }
            return (CT_HTML, bytes(out));
        } catch {
            return (CT_HTML, bytes(MARKER_RENDER_FAILED));
        }
    }

    // ── honesty (the `abx verify` / marketplace-tooling surface) ────────────--

    /// @notice The branch this token takes, its chain-completeness, and its failure modes.
    /// @return branch 0 = none, 1 = template, 2 = directory (template wins when both).
    /// @return chainComplete template branch on which every dependency RESOLVES to on-chain bytes
    ///         (gzip tags or inline SSTORE2) rather than to a CDN, gateway, or server. Always false
    ///         off the template branch.
    ///
    ///         Read that precisely: it is a statement about **where each dependency resolves from**,
    ///         which is what this function can verify from the registry's own resolution metadata.
    ///         It is NOT a promise about what the assembled document does at runtime. On-chain bytes
    ///         are still arbitrary JavaScript, and a dependency's script can `fetch()` anything it
    ///         likes, or emit a remote `<script src>` of its own — a registry operator serving a
    ///         dependency can put either inside the payload, and no view could see it without
    ///         executing the code. `chainComplete` means the GRAPH THIS CONTRACT ASSEMBLES pulls
    ///         nothing off-chain; it does not mean the work is hermetic.
    ///
    ///         The honest boundary, stated once: a project using a dependency registry it does not
    ///         control is trusting that registry's operator, exactly as with any CDN. A project that
    ///         wants no such assumption stores its code on-chain or points at a registry it owns.
    /// @return unresolvedRefs refs that emit `<!-- abx:unresolved … -->` markers (CDN-resolved
    ///         deps break chain-completeness but are NOT unresolved — they serve fine).
    /// @return urlOverBudget directory branch: the emitted URL (measured for token 0, the
    ///         series' first mint — representative, not definitive: the enumerated surface
    ///         includes token-scope params, so a later token's payload can be longer) exceeds
    ///         {URL_BUDGET_BYTES}. Always false off the directory branch.
    function onChainStatus(address token)
        external
        view
        returns (uint8 branch, bool chainComplete, bytes32[] memory unresolvedRefs, bool urlOverBudget)
    {
        branch = _branch(token);
        unresolvedRefs = new bytes32[](0);
        if (branch == BRANCH_TEMPLATE) {
            uint256 n = _dependencyCount(token);
            if (n > MAX_DEPENDENCIES) {
                // Truncating AND SAYING SO, which {MAX_DEPENDENCIES} promises and this call used to
                // skip: past the bound the extra dependencies are silently dropped from the walk, so
                // reporting `chainComplete = true` off a partial graph would be the one answer worse
                // than refusing. A project over the bound gets `false` — the document is truncated
                // too, so incomplete is the truth.
                return (branch, false, new bytes32[](0), false);
            }
            unresolvedRefs = new bytes32[](n);
            uint256 unresolved;
            bool allOnChain = true;
            for (uint256 i; i < n; ++i) {
                (uint8 class, bytes32 ref) = _classifyDep(token, i);
                if (class == CLASS_UNRESOLVED) {
                    unresolvedRefs[unresolved++] = ref;
                    allOnChain = false;
                } else if (class == CLASS_CDN) {
                    allOnChain = false;
                }
            }
            assembly {
                mstore(unresolvedRefs, unresolved) // shrink to the filled prefix
            }
            chainComplete = allOnChain;
        } else if (branch == BRANCH_DIRECTORY) {
            try this.document(token, 0) returns (string memory url) {
                urlOverBudget = bytes(url).length > URL_BUDGET_BYTES;
            } catch {}
        }
    }

    // ── piecewise reads (client-side assembly past any RPC gas cap) ─────────--

    /// @notice The raw output {render} builds: the full HTML document (template branch), the
    ///         parameterized locator URL (directory branch; empty when the `code` field's
    ///         representation is unserveable), or a comment marker (no code).
    /// @dev May revert on a non-ABX token — {render} wraps it and degrades; direct callers
    ///      (the CLI) pass real ABX tokens.
    function document(address token, uint256 tokenId) public view returns (string memory) {
        uint8 branch = _branch(token);
        if (branch == BRANCH_TEMPLATE) return _templateDocument(token, tokenId);
        if (branch == BRANCH_DIRECTORY) return _directoryUrl(token, tokenId);
        return MARKER_NO_CODE;
    }

    /// @notice The canonical `tokenData` JSON this generator injects: the reserved
    ///         coordinates + `seed` + every param the token enumerates (both scopes unioned,
    ///         token-scope-wins, canonical decode, keys sorted lexicographically — the
    ///         canonical serialization; see the contract natspec) + the augment hook's
    ///         entries (last, augment-wins). A token without the enumeration surface:
    ///         coordinates + `seed` + augment entries only. Raw JSON — the inline `<` escape
    ///         is delivery form only, applied in {document}.
    function tokenDataJson(address token, uint256 tokenId) public view returns (string memory) {
        string memory out = _canonicalOpen(token, tokenId);
        // the augment hook is read-time project code — a broken hook must never take
        // tokenData down (matches the off-chain serializer's best-effort rule).
        try this.augmentedEntries(token, tokenId) returns (string memory aug) {
            out = string.concat(out, aug);
        } catch {}
        return TokenDataLib.finish(out);
    }

    /// @notice The augment hook's tokenData entries as a leading-comma JSON fragment
    ///         (`,"key":"value"…`); empty without a hook. External so {tokenDataJson} can
    ///         guard it — also a useful piecewise read.
    function augmentedEntries(address token, uint256 tokenId) external view returns (string memory) {
        return TokenDataLib.augmentedEntries("", token, tokenId);
    }

    /// @notice The assembled `<script>` tag for the dependency at `index`, exactly as it
    ///         rides in {document}: an inert gzip data-URI tag (registry on-chain bytes,
    ///         chunks verbatim), a plain inline tag (OnChain SSTORE2 ref), a CDN `src` tag,
    ///         or the `<!-- abx:unresolved … -->` marker.
    function dependencyTag(address token, uint256 index) external view returns (string memory) {
        (string memory tag,) = _depTag(token, index);
        return tag;
    }

    /// @notice The `code` collection field (directory mode), raw. External so {_branch} can
    ///         probe it without trusting the token's ABI — also a useful piecewise read.
    function codeLocator(address token)
        external
        view
        returns (bytes32 representation, bytes memory value)
    {
        return IAbxOnChainMetadata(token).contractField(F_CODE);
    }

    /// @notice The baked `abx.js` source (what template documents inline).
    function abxJs() external view returns (string memory) {
        return string(SSTORE2.read(abxJsPointer));
    }

    /// @notice The baked gunzip bootstrap source (raw JS; documents carry it base64'd).
    function gunzipScript() external view returns (string memory) {
        return string(SSTORE2.read(gunzipScriptPointer));
    }

    /// @notice A registry entry's resolution-relevant details (the 9-tuple, trimmed).
    ///         External so dep resolution can guard it — also a useful piecewise read.
    function registryDetails(address registry, bytes32 ref)
        external
        view
        returns (string memory preferredCDN, bool availableOnChain, uint256 scriptCount)
    {
        (,, string memory cdn,,,,, bool onChain, uint24 count) =
            IDependencyRegistryV0(registry).getDependencyDetails(ref);
        return (cdn, onChain, uint256(count));
    }

    /// @notice One registry script chunk, verbatim (stored pre-gzip'd + pre-base64'd).
    function registryScriptChunk(address registry, bytes32 ref, uint256 index)
        external
        view
        returns (string memory)
    {
        return IDependencyRegistryV0(registry).getDependencyScript(ref, index);
    }

    /// @notice The token's set param keys at both scopes — the surface {tokenDataJson}
    ///         serializes (`seed` is never listed; it rides as a reserved coordinate).
    ///         External so the tokenData assembly can guard it — a token without the
    ///         enumeration surface reads as no params — and a useful piecewise read.
    function paramKeysOf(address token, uint256 tokenId)
        external
        view
        returns (bytes32[] memory contractKeys, bytes32[] memory tokenKeys)
    {
        return (IAbxParams(token).contractParamKeys(), IAbxParams(token).tokenParamKeys(tokenId));
    }

    /// @notice A key's Configurable Params schema, trimmed to what the canonical decode
    ///         needs. External so the tokenData assembly can guard it (a token without the
    ///         extension reads as schema-less) — also a useful piecewise read.
    function paramSchemaOf(address token, bytes32 key)
        external
        view
        returns (bool exists, IAbxConfigurableParams.ParamType paramType, uint256 optionCount)
    {
        // The COUNT, not the table. `paramSchema` returns the whole `string[]`, so resolving one
        // selected option used to copy every option on every render — an owner-created 200-entry
        // table then costs every `tokenURI` call for the life of the project, to look up one index.
        (bool ex, IAbxConfigurableParams.ParamType pt,,,,,, uint256 n) =
            IAbxConfigurableParams(token).paramSchemaHead(key);
        return (ex, pt, n);
    }

    /// @dev One option, fetched only once the index is known to be in range. Guarded like every
    ///      other cross-contract read here: a token that reverts degrades, it never blocks.
    function selectOptionOf(address token, bytes32 key, uint256 index)
        external
        view
        returns (string memory)
    {
        return IAbxConfigurableParams(token).selectOption(key, index);
    }

    // ── branch derivation (never reverts) ───────────────────────────────────--

    /// @dev Template wins when both (the AB pattern: chunks for preservation, directory for
    ///      serving — on-chain, the chunks are the stronger promise).
    function _branch(address token) internal view returns (uint8) {
        if (_scriptChunkCount(token) != 0) return BRANCH_TEMPLATE;
        try this.codeLocator(token) returns (bytes32, bytes memory value) {
            if (value.length != 0) return BRANCH_DIRECTORY;
        } catch {}
        return BRANCH_NONE;
    }

    /// @dev Guarded fixed-size read — any failure (no code, revert, wrong shape) reads as 0.
    function _scriptChunkCount(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IAbxOnChainScript.scriptChunkCount, ()));
        if (!ok || ret.length != 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @dev Guarded fixed-size read — any failure reads as 0 dependencies.
    function _dependencyCount(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IAbxDependencies.dependencyCount, ()));
        if (!ok || ret.length != 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @dev The collection's registry pointer, else the per-chain default (the Consumers
    ///      rule). Guarded: an unreadable pointer falls back to the default.
    function _activeRegistry(address token) internal view returns (address) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IAbxDependencies.dependencyRegistry, ()));
        if (ok && ret.length == 32) {
            address registry = address(uint160(abi.decode(ret, (uint256))));
            if (registry != address(0)) return registry;
        }
        return defaultDependencyRegistry;
    }

    // ── the template branch ─────────────────────────────────────────────────--

    /// @dev The resolver's reference document shape, byte-identical modulo resolution lane
    ///      (the resolver inflates registry gzip bytes server-side; on-chain they ride
    ///      verbatim as inert gzip tags + the bootstrap): measure everything, allocate once,
    ///      append (scripty's pattern).
    function _templateDocument(address token, uint256 tokenId)
        internal
        view
        returns (string memory)
    {
        // every "<" in the JSON payload becomes its unicode escape (backslash-u003c) —
        // parse-identical, and can no longer end a script element early (the resolver's
        // escapeInlineJson rule).
        string memory json = LibString.replace(tokenDataJson(token, tokenId), "<", "\\u003c");
        string memory abxjs = string(SSTORE2.read(abxJsPointer));

        // dependency tags in order; the gunzip bootstrap rides once, after the LAST gzip tag.
        // Guarded read + bounded allocation: this used to be a raw typed call whose result sized an
        // array directly, so a token reporting an absurd count killed the document instead of
        // degrading (see {MAX_DEPENDENCIES}).
        uint256 depCount = _dependencyCount(token);
        if (depCount > MAX_DEPENDENCIES) depCount = MAX_DEPENDENCIES;
        string[] memory tags = new string[](depCount);
        uint256 lastGzip = type(uint256).max;
        uint256 tagsLength;
        for (uint256 i; i < depCount; ++i) {
            (string memory tag, uint8 class) = _depTag(token, i);
            tags[i] = tag;
            tagsLength += bytes(tag).length + 1; // +1: the joining newline
            if (class == CLASS_GZIP) lastGzip = i;
        }
        string memory bootstrapTag;
        if (lastGzip != type(uint256).max) {
            bootstrapTag = _gunzipBootstrapTag();
            tagsLength += bytes(bootstrapTag).length + 1;
        }

        string memory script = _escapedScript(token);

        uint256 total = bytes(SHELL_HEAD).length + bytes(SHELL_ABXJS_OPEN).length
            + bytes(SHELL_ABXJS_CLOSE).length + bytes(SHELL_BODY).length
            + bytes(SHELL_TAIL).length;
        total += bytes(json).length;
        total += bytes(abxjs).length;
        total += tagsLength;
        total += bytes(script).length;
        bytes memory buffer = DynamicBuffer.allocate(total);
        DynamicBuffer.appendSafe(buffer, bytes(SHELL_HEAD));
        DynamicBuffer.appendSafe(buffer, bytes(json));
        DynamicBuffer.appendSafe(buffer, bytes(SHELL_ABXJS_OPEN));
        DynamicBuffer.appendSafe(buffer, bytes(abxjs));
        DynamicBuffer.appendSafe(buffer, bytes(SHELL_ABXJS_CLOSE));
        for (uint256 i; i < depCount; ++i) {
            DynamicBuffer.appendSafe(buffer, bytes("\n"));
            DynamicBuffer.appendSafe(buffer, bytes(tags[i]));
            if (i == lastGzip) {
                DynamicBuffer.appendSafe(buffer, bytes("\n"));
                DynamicBuffer.appendSafe(buffer, bytes(bootstrapTag));
            }
        }
        DynamicBuffer.appendSafe(buffer, bytes(SHELL_BODY));
        DynamicBuffer.appendSafe(buffer, bytes(script));
        DynamicBuffer.appendSafe(buffer, bytes(SHELL_TAIL));
        return string(buffer);
    }

    /// @dev All script chunks joined with '\n' (the resolver's join), `</script` → `<\/script`
    ///      (semantics-preserving inline-script escape).
    function _escapedScript(address token) internal view returns (string memory) {
        uint256 n = IAbxOnChainScript(token).scriptChunkCount();
        if (n > MAX_SCRIPT_CHUNKS) n = MAX_SCRIPT_CHUNKS; // bound BEFORE allocating
        bytes[] memory chunks = new bytes[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            chunks[i] = IAbxOnChainScript(token).scriptChunk(i);
            total += chunks[i].length;
        }
        bytes memory buffer = DynamicBuffer.allocate(total + (n == 0 ? 0 : n - 1));
        for (uint256 i; i < n; ++i) {
            if (i != 0) DynamicBuffer.appendSafe(buffer, bytes("\n"));
            DynamicBuffer.appendSafe(buffer, chunks[i]);
        }
        return _escapeScriptClose(string(buffer));
    }

    /// @dev Insert a backslash before every `</script`, matching the tag name **case-insensitively**
    ///      — `<\/SCRIPT` is a semantics-preserving escape in JS, and a browser ends a script
    ///      element on `</script` in any case, so a case-sensitive match under-escaped. This was a
    ///      plain `LibString.replace(…, "</script", …)`, which meant `</SCRIPT>` in a script body
    ///      came back escaped from the off-chain reference generator (`/gi`) and raw from here: the
    ///      same token rendering differently depending on which surface served it, against a
    ///      documented byte-parity guarantee.
    ///
    ///      Structured so the common case stays cheap, because this sits on the shared document read
    ///      path. A byte-by-byte scan would cost ~5M gas per pass on a 100 KB script; instead
    ///      `indexOf` span-scans for `</` — of which real JS has very few — and only those positions
    ///      pay a 6-byte comparison. A script with no `</` at all returns after a single span scan.
    function _escapeScriptClose(string memory src) private pure returns (string memory) {
        uint256 at = LibString.indexOf(src, "</", 0);
        if (at == LibString.NOT_FOUND) return src; // fast path: nothing to escape

        bytes memory b = bytes(src);
        uint256 hits;
        for (uint256 i = at; i != LibString.NOT_FOUND; i = LibString.indexOf(src, "</", i + 1)) {
            if (_isScriptWord(b, i + 2)) ++hits;
        }
        if (hits == 0) return src;

        bytes memory out = DynamicBuffer.allocate(b.length + hits);
        uint256 start;
        for (uint256 i = at; i != LibString.NOT_FOUND; i = LibString.indexOf(src, "</", i + 1)) {
            if (!_isScriptWord(b, i + 2)) continue;
            DynamicBuffer.appendSafe(out, LibBytes.slice(b, start, i + 1)); // through the '<'
            DynamicBuffer.appendSafe(out, bytes("\\"));
            start = i + 1; // the '/script…' rides verbatim from here
        }
        DynamicBuffer.appendSafe(out, LibBytes.slice(b, start, b.length));
        return string(out);
    }

    /// @dev ASCII-case-insensitive `"script"` at `at`. `| 0x20` lowercases a letter; the six
    ///      literals are `s c r i p t`.
    function _isScriptWord(bytes memory b, uint256 at) private pure returns (bool) {
        if (at + 6 > b.length) return false;
        return (uint8(b[at]) | 0x20) == 0x73 && (uint8(b[at + 1]) | 0x20) == 0x63
            && (uint8(b[at + 2]) | 0x20) == 0x72 && (uint8(b[at + 3]) | 0x20) == 0x69
            && (uint8(b[at + 4]) | 0x20) == 0x70 && (uint8(b[at + 5]) | 0x20) == 0x74;
    }

    /// @dev One dependency → its tag + class. Resolution per the Consumers row: registry
    ///      on-chain bytes (verbatim gzip tag) → preferredCDN → unresolved marker; OnChain
    ///      refs read their SSTORE2 data contract directly (never a registry). Registry reads
    ///      are guarded — a reverting/absent registry degrades to the marker.
    function _depTag(address token, uint256 index)
        internal
        view
        returns (string memory tag, uint8 class)
    {
        (IAbxDependencies.Resolution resolution, bytes32 ref) =
            IAbxDependencies(token).dependencyByIndex(index);

        if (resolution == IAbxDependencies.Resolution.OnChain) {
            // an OnChain ref IS an address, left-aligned in bytes32 (IAbxDependencies)
            // forge-lint: disable-next-line(unsafe-typecast)
            address pointer = address(bytes20(ref));
            // SSTORE2 layout: 0x00 guard byte ‖ content — data exists iff code.length > 1.
            if (pointer.code.length > 1) {
                // Same case-insensitive escape the script body gets. This call site was the
                // sibling the first pass missed: an inline dependency's bytes rode through a
                // case-SENSITIVE `LibString.replace`, so `</SCRIPT` ended the element early and
                // broke parity with the off-chain `deps.ts`, which uses the shared `/gi` helper.
                // Escaping is a per-call-site property, not a per-file one — sweep the class.
                string memory js = _escapeScriptClose(string(SSTORE2.read(pointer)));
                return (string.concat("<script>", js, "</script>"), CLASS_INLINE);
            }
            return (
                string.concat("<!-- abx:unresolved ", LibString.toHexString(pointer), " -->"),
                CLASS_UNRESOLVED
            );
        }

        address registry = _activeRegistry(token);
        if (registry == address(0)) return (_unresolvedMarker(ref), CLASS_UNRESOLVED);
        try this.registryDetails(registry, ref) returns (
            string memory cdn, bool availableOnChain, uint256 scriptCount
        ) {
            if (availableOnChain && scriptCount != 0) {
                // A registry-declared count is a foreign number; bound it before it becomes an
                // allocation. Past the bound the dependency is unresolved rather than allowed to
                // take the whole document down with it.
                if (scriptCount > MAX_SCRIPT_CHUNKS) return (_unresolvedMarker(ref), CLASS_UNRESOLVED);
                return _gzipTag(registry, ref, scriptCount);
            }
            if (bytes(cdn).length != 0 && _attrSafe(cdn)) {
                return (string.concat("<script src=\"", cdn, "\"></script>"), CLASS_CDN);
            }
            return (_unresolvedMarker(ref), CLASS_UNRESOLVED);
        } catch {
            return (_unresolvedMarker(ref), CLASS_UNRESOLVED);
        }
    }

    /// @dev The inert gzip data-URI tag: chunks are stored pre-gzip'd + pre-base64'd and ride
    ///      VERBATIM — zero transcoding on-chain. Any chunk-read failure → the marker.
    function _gzipTag(address registry, bytes32 ref, uint256 scriptCount)
        internal
        view
        returns (string memory, uint8)
    {
        string[] memory chunks = new string[](scriptCount);
        uint256 total;
        for (uint256 i; i < scriptCount; ++i) {
            try this.registryScriptChunk(registry, ref, i) returns (string memory chunk) {
                // Chunks ride VERBATIM, unscanned. They are base64 in every honest case and land
                // inside `src="…"`, so a chunk carrying a quote could close the attribute and inject
                // markup.
                //
                // Be precise about WHOSE bytes these are, because it is not always the project
                // owner's: {_activeRegistry} falls back to `defaultDependencyRegistry` whenever the
                // collection's own pointer is zero, which is the DEFAULT state. So on a typical
                // project these bytes belong to whoever operates the chain's default registry.
                //
                // Scanning does not change that. A registry operator serving a dependency can put
                // whatever JavaScript it likes INSIDE the gzip payload, which is decompressed and
                // executed by the document either way — the escape-the-attribute route adds no
                // capability they do not already have. The real assumption is the one every
                // dependency registry carries: using a shared registry means trusting its operator
                // not to swap the bytes underneath you, exactly as with any CDN. Disclosed, not
                // defended against — `onChainStatus()` reports which dependencies resolve through a
                // registry, and a project that wants no such assumption stores its code on-chain or
                // points at a registry it controls.
                chunks[i] = chunk;
                total += bytes(chunk).length;
            } catch {
                return (_unresolvedMarker(ref), CLASS_UNRESOLVED);
            }
        }
        bytes memory buffer = DynamicBuffer.allocate(
            bytes(GZIP_TAG_OPEN).length + total + bytes(DATA_TAG_CLOSE).length
        );
        DynamicBuffer.appendSafe(buffer, bytes(GZIP_TAG_OPEN));
        for (uint256 i; i < scriptCount; ++i) {
            DynamicBuffer.appendSafe(buffer, bytes(chunks[i]));
        }
        DynamicBuffer.appendSafe(buffer, bytes(DATA_TAG_CLOSE));
        return (string(buffer), CLASS_GZIP);
    }

    /// @dev The bootstrap rides AB's tag shape — a base64 data-URI script (never inline, so
    ///      its content can never end a <script> element early). ~9.4KB raw; the one on-chain
    ///      base64 in the pipeline (in-place, via {DynamicBuffer.appendSafeBase64}).
    function _gunzipBootstrapTag() internal view returns (string memory) {
        bytes memory raw = SSTORE2.read(gunzipScriptPointer);
        uint256 encodedLength = 4 * ((raw.length + 2) / 3);
        bytes memory buffer = DynamicBuffer.allocate(
            bytes(B64_TAG_OPEN).length + encodedLength + bytes(DATA_TAG_CLOSE).length
        );
        DynamicBuffer.appendSafe(buffer, bytes(B64_TAG_OPEN));
        DynamicBuffer.appendSafeBase64(buffer, raw, false, false);
        DynamicBuffer.appendSafe(buffer, bytes(DATA_TAG_CLOSE));
        return string(buffer);
    }

    /// @dev The `<!-- abx:unresolved … -->` marker (ASCII `name` + `version` ref) — honest
    ///      degradation, never a revert.
    function _unresolvedMarker(bytes32 ref) internal pure returns (string memory) {
        return string.concat("<!-- abx:unresolved ", _commentSafe(TokenDataLib.keyToString(ref)), " -->");
    }

    /// @dev Neutralize `<` and `>` so a string cannot escape the HTML comment it is being placed in.
    ///      A dependency ref is registry-supplied, and `-->` inside one closed the comment and let the
    ///      remainder land as live markup in the work document. Only the two characters that can
    ///      open a tag or close a comment are touched, so a readable `name` plus `version` (dashes
    ///      and all) stays readable — the marker is a diagnostic, and a diagnostic nobody can read is
    ///      its own problem.
    function _commentSafe(string memory src) internal pure returns (string memory) {
        bytes memory b = bytes(src);
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == "<" || b[i] == ">") b[i] = "_";
        }
        return string(b);
    }

    /// @dev Whether a registry-supplied URL can be placed inside a double-quoted HTML attribute.
    ///      A `"` closes the attribute and `<`/`>` open or close a tag, so any of the three turns
    ///      `<script src="…">` into attacker-chosen markup. A URL containing them is malformed
    ///      anyway, so this fails CLOSED — the dependency reports unresolved rather than being
    ///      silently escaped into something that looks fine and isn't.
    function _attrSafe(string memory src) internal pure returns (bool) {
        bytes memory b = bytes(src);
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == '"' || b[i] == "<" || b[i] == ">") return false;
        }
        return true;
    }

    /// @dev Light classification for {onChainStatus} — same resolution order as {_depTag}
    ///      without materializing bytes. Fully guarded (fixed-size low-level reads + probes).
    function _classifyDep(address token, uint256 index)
        internal
        view
        returns (uint8 class, bytes32 ref)
    {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IAbxDependencies.dependencyByIndex, (index)));
        if (!ok || ret.length != 64) return (CLASS_UNRESOLVED, bytes32(0));
        (uint256 resolution, bytes32 r) = abi.decode(ret, (uint256, bytes32));
        ref = r;
        if (resolution == uint256(IAbxDependencies.Resolution.OnChain)) {
            // an OnChain ref IS an address, left-aligned in bytes32 (IAbxDependencies)
            // forge-lint: disable-next-line(unsafe-typecast)
            address pointer = address(bytes20(ref));
            return (pointer.code.length > 1 ? CLASS_INLINE : CLASS_UNRESOLVED, ref);
        }
        address registry = _activeRegistry(token);
        if (registry == address(0)) return (CLASS_UNRESOLVED, ref);
        try this.registryDetails(registry, ref) returns (
            string memory cdn, bool availableOnChain, uint256 scriptCount
        ) {
            // Both branches must apply the SAME fails-closed checks {_depTag} applies, or this
            // classifier reports a dependency as resolved that the document renders as unresolved —
            // and `onChainStatus`/`chainComplete`, which is what a buyer actually reads, would be
            // reporting a graph the token does not produce.
            if (availableOnChain && scriptCount != 0) return (CLASS_GZIP, ref);
            if (bytes(cdn).length != 0 && _attrSafe(cdn)) return (CLASS_CDN, ref);
            return (CLASS_UNRESOLVED, ref);
        } catch {
            return (CLASS_UNRESOLVED, ref);
        }
    }

    // ── tokenData params (on-chain enumeration) ─────────────────────────────--

    /// @dev Open the tokenData object in CANONICAL form: the reserved coordinates + `seed`
    ///      + every param the token enumerates at either scope (token scope wins; a key set
    ///      at both appears once), ALL keys sorted lexicographically (the serialization is
    ///      hashed — inputsHash — so byte parity with the SDK serializer's settled form is
    ///      load-bearing). Returns the object WITHOUT the closing brace
    ///      ({TokenDataLib.finish} closes; augment entries append before it, last-wins).
    ///      Defensive throughout: the enumeration read is guarded (no surface ⇒ no params),
    ///      a reserved key a hostile getter lists is skipped, duplicates keep the first.
    function _canonicalOpen(address token, uint256 tokenId) internal view returns (string memory) {
        bytes32[] memory contractKeys;
        bytes32[] memory tokenKeys;
        try this.paramKeysOf(token, tokenId) returns (bytes32[] memory ck, bytes32[] memory tk) {
            (contractKeys, tokenKeys) = (ck, tk);
        } catch {}

        uint256 listed = contractKeys.length + tokenKeys.length;
        string[] memory names = new string[](listed + 4);
        string[] memory fragments = new string[](listed + 4);
        uint256 count;

        names[count] = "chainId";
        fragments[count++] = string.concat('"chainId":', LibString.toString(block.chainid));
        names[count] = "contractAddress";
        fragments[count++] =
            string.concat('"contractAddress":"', LibString.toHexString(token), '"');
        names[count] = "tokenId";
        fragments[count++] = string.concat('"tokenId":"', LibString.toString(tokenId), '"');
        {
            (bytes32 seed,, bool seedSet) = IAbxParams(token).tokenParam(tokenId, K_SEED);
            if (seedSet) {
                names[count] = "seed";
                fragments[count++] =
                    string.concat('"seed":"', LibString.toHexString(uint256(seed), 32), '"');
            }
        }
        for (uint256 i; i < listed; ++i) {
            // the two scopes read as one list; both resolve token-first below, so a key in
            // both yields identical adjacent entries and the duplicate collapse keeps one
            bytes32 key =
                i < contractKeys.length ? contractKeys[i] : tokenKeys[i - contractKeys.length];
            // coordinates win — a reserved key a hostile getter lists is ignored (defensive)
            if (
                key == "chainId" || key == "contractAddress" || key == "tokenId" || key == K_SEED
            ) continue;
            (bool present, string memory fragment) = _paramFragment(token, tokenId, key);
            if (!present) continue;
            names[count] = TokenDataLib.keyToString(key);
            fragments[count++] = fragment;
        }

        // stable insertion sort by key name (N is small); adjacent duplicates then collapse
        for (uint256 i = 1; i < count; ++i) {
            string memory name = names[i];
            string memory fragment = fragments[i];
            uint256 j = i;
            while (j > 0 && LibString.cmp(names[j - 1], name) > 0) {
                names[j] = names[j - 1];
                fragments[j] = fragments[j - 1];
                --j;
            }
            names[j] = name;
            fragments[j] = fragment;
        }

        string memory out = "{";
        for (uint256 i; i < count; ++i) {
            if (i != 0 && LibString.eq(names[i], names[i - 1])) continue; // both-scope duplicate
            out = bytes(out).length == 1
                ? string.concat(out, fragments[i])
                : string.concat(out, ",", fragments[i]);
        }
        return out;
    }

    /// @dev One enumerated param → its `"key":"value"` fragment. Token scope wins over
    ///      contract scope (the SDK merge rule); unset in both → absent. The key name is
    ///      JSON-escaped defensively (a hostile key can't break the object).
    function _paramFragment(address token, uint256 tokenId, bytes32 key)
        internal
        view
        returns (bool present, string memory fragment)
    {
        (bytes32 value, bool valueIsHash, bool isSet) = IAbxParams(token).tokenParam(tokenId, key);
        bool tokenScope = isSet;
        if (!isSet) {
            (value, valueIsHash, isSet) = IAbxParams(token).contractParam(key);
        }
        if (!isSet) return (false, "");
        return (
            true,
            string.concat(
                '"',
                LibString.escapeJSON(TokenDataLib.keyToString(key)),
                '":"',
                _decodeParamValue(token, tokenId, key, value, valueIsHash, tokenScope),
                '"'
            )
        );
    }

    /// @dev The canonical decode, byte-consistent with the SDK serializer (`buildTokenData`):
    ///      a schema'd scalar decodes per its type ({TokenDataLib.decodeScalar}; `Select` →
    ///      the option string, out-of-range → the decimal index); a schema'd `String` blob is
    ///      UTF-8 (JSON-escaped here); `Bytes` + schema-less blobs base64; a schema-less
    ///      literal follows the SDK's loose-tag rule — printable-ASCII text, else the full
    ///      bytes32 hex. An unreadable/absent schema surface reads as schema-less.
    function _decodeParamValue(
        address token,
        uint256 tokenId,
        bytes32 key,
        bytes32 value,
        bool valueIsHash,
        bool tokenScope
    ) internal view returns (string memory) {
        bool exists;
        IAbxConfigurableParams.ParamType paramType;
        uint256 optionCount;
        try this.paramSchemaOf(token, key) returns (
            bool ex, IAbxConfigurableParams.ParamType pt, uint256 n
        ) {
            (exists, paramType, optionCount) = (ex, pt, n);
        } catch {}

        if (!valueIsHash) {
            if (!exists) return TokenDataLib.decodeTagLoose(value);
            if (paramType == IAbxConfigurableParams.ParamType.Select) {
                uint256 index = uint256(value);
                if (index < optionCount) {
                    try this.selectOptionOf(token, key, index) returns (string memory opt) {
                        return LibString.escapeJSON(opt);
                    } catch {}
                }
                return LibString.toString(index); // SDK fallback: the decimal index
            }
            return TokenDataLib.decodeScalar(paramType, value);
        }

        // data-backed: read the WINNING scope's blob (the merge already picked the scope)
        bytes memory data = tokenScope
            ? IAbxParams(token).tokenParamData(tokenId, key)
            : IAbxParams(token).contractParamData(key);
        if (data.length == 0) return LibString.toHexString(uint256(value), 32); // SDK floor: the hash
        if (exists && paramType == IAbxConfigurableParams.ParamType.String) {
            return LibString.escapeJSON(string(data));
        }
        return Base64.encode(data); // Bytes + schema-less blobs: base64 at read, never stored
    }

    // ── the directory branch ────────────────────────────────────────────────--

    /// @dev `{gateway}{root}/index.html?abx=<base64url(tokenData)>` — the durability
    ///      convention for URL-carried tokenData. Locator handling mirrors the resolver's
    ///      `codeLocatorUrl`: an absolute http(s) root rides verbatim (never re-prefixed);
    ///      `ipfs`/`arweave` roots ride the scheme's gateway (the collection's
    ///      `abx_gateway_ipfs` / `abx_gateway_arweave` field overrides the default — a dead
    ///      gateway is a repoint, not a rot); a root already naming
    ///      an `.html` entry is used as-is. Unserveable representation → empty string
    ///      ({render} degrades to a marker).
    function _directoryUrl(address token, uint256 tokenId) internal view returns (string memory) {
        (bytes32 representation, bytes memory value) =
            IAbxOnChainMetadata(token).contractField(F_CODE);
        if (value.length == 0) return "";
        string memory root = string(value);

        string memory base;
        if (LibString.startsWith(root, "https://") || LibString.startsWith(root, "http://")) {
            base = root; // already absolute — serve verbatim, never double-prefix
        } else if (representation == R_URL) {
            base = root;
        } else if (representation == R_IPFS) {
            if (LibString.startsWith(root, "ipfs://")) root = LibString.slice(root, 7);
            base = string.concat(_gateway(token, F_GATEWAY_IPFS, defaultIpfsGateway), root);
        } else if (representation == R_ARWEAVE) {
            if (LibString.startsWith(root, "ar://")) root = LibString.slice(root, 5);
            base = string.concat(_gateway(token, F_GATEWAY_ARWEAVE, defaultArweaveGateway), root);
        } else {
            return ""; // `code` is locators-only by the registry; anything else is unserveable
        }

        string memory entry;
        if (LibString.endsWith(base, ".html")) {
            entry = base;
        } else {
            if (LibString.endsWith(base, "/")) {
                base = LibString.slice(base, 0, bytes(base).length - 1);
            }
            entry = string.concat(base, "/index.html");
        }

        bytes memory json = bytes(tokenDataJson(token, tokenId));
        bytes memory buffer = DynamicBuffer.allocate(
            bytes(entry).length + 5 /* "?abx=" */ + 4 * ((json.length + 2) / 3)
        );
        DynamicBuffer.appendSafe(buffer, bytes(entry));
        DynamicBuffer.appendSafe(buffer, bytes("?abx="));
        // base64url: fileSafe + noPadding — what abx.js's query-param decoder expects.
        DynamicBuffer.appendSafeBase64(buffer, json, true, true);
        return string(buffer);
    }

    /// @dev The collection's preferred gateway prefix for a scheme, else this generator's
    ///      constructor default. Read from the reserved COLLECTION-scope metadata fields
    ///      `abx_gateway_ipfs` / `abx_gateway_arweave` — the SAME two the metadata renderer and the
    ///      off-chain resolver read, so a project has one gateway answer and not one per surface.
    ///
    ///      This superseded the `display.gateway` contract param, which could only name one prefix
    ///      for both schemes and existed only on code tokens — leaving image 1/1s and series, which
    ///      are exactly the `--onchain-uri --backend ipfs|arweave` headline, with no way to state a
    ///      preference at all. There is deliberately no compatibility read of the old param: two
    ///      places to set one value is how the two lanes end up disagreeing.
    function _gateway(address token, bytes32 field, string memory defaultGateway)
        internal
        view
        returns (string memory)
    {
        (bytes32 rep, bytes memory value) = IAbxOnChainMetadata(token).contractField(field);
        if (value.length != 0 && rep == R_INLINE) return string(value);
        return defaultGateway;
    }
}
