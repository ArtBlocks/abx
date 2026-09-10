// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IAbxMetadataRenderer} from "../uri/IAbxMetadataRenderer.sol";
import {IAbxFieldRenderer} from "../uri/IAbxFieldRenderer.sol";
import {IAbxOnChainMetadata} from "../extensions/onchain-metadata/IAbxOnChainMetadata.sol";
import {IAbxOnChainReader} from "../extensions/onchain-metadata/IAbxOnChainReader.sol";

/// @dev Minimal view of the token's ERC-721 collection name (for the `name` fallback).
interface ICollectionName {
    function name() external view returns (string memory);
}

/// @title AbxMetadataRenderer — the canonical on-chain metadata renderer
/// @notice Assembles a token's ERC-721 JSON and a collection's ERC-7572 JSON entirely
///         on-chain, as `data:application/json;base64` URIs, by reading the token's
///         {IAbxOnChainMetadata} fields. Stateless and shared — one deployment serves
///         every ABX token on the chain. The Solidity twin of the off-chain resolver:
///         same spec, both surfaces agree on which fields resolve, which fall back, and
///         how. Spec-versioned via {specVersion}.
/// @dev Field requiredness + fallbacks:
///      - REQUIRED `name` (fallback `"{collection name} #{tokenId}"`) and `image`
///        (fallback: a simple deterministic SVG from the contract address + tokenId,
///        byte-identical to the off-chain resolver's fallback).
///      - everything else OPTIONAL → omitted when unset.
///
///      **Field resolution is two-scope:** for a token field the renderer reads the
///      TOKEN scope first, then falls back to the COLLECTION scope. So one collection-scope
///      field (e.g. `image` as a `url-template`, or a shared `description`) covers every
///      token in O(1) storage, while a per-token field overrides it. `abx_provenance`
///      marks a collection-sourced value with `[collection]`.
///
///      Supported on-chain representations: `inline` (bytes as content), `reader`
///      (call {IAbxOnChainReader.read} — stored bytes), `renderer` (call
///      {IAbxFieldRenderer.render} — COMPUTED bytes: in-chain SVG, on-chain trait arrays,
///      full HTML documents; collection-surface reads pass `tokenId = type(uint256).max`),
///      `url` (a locator, passed through), `url-template` (`{id}` → the decimal
///      `tokenId`, so one field addresses a whole IPFS/Arweave directory), and — as of v11 —
///      `ipfs`/`arweave`, projected through the collection's preferred gateway (see below).
///      NOT renderable on-chain: `keccak256`/`sha256` (off-chain custody, hash only) and any
///      off-chain-decode tag (e.g.
///      `inline-gzip`) — a required field with such a representation falls back; an
///      optional one is omitted; either way `abx_provenance` says so. Inline/`reader`
///      `image` bytes are interpreted as SVG and inline/`reader` `animation_url` bytes as
///      HTML — both wrapped as a `data:` URI (v4), since both fields are URI-valued;
///      `renderer` bytes carry their own contentType. A text-field renderer returning
///      contentType `text/uri-list` is a computed LOCATOR: its bytes land verbatim as the
///      field's value (never data-wrapped) — the canonical generator's directory branch
///      rides this.
/// @dev v2 adds the data plane's `artifacts` manifest: one namespaced array of
///      `{key, mimeType, uri}` entries, emitted only when non-empty. The protocol
///      lets an on-chain renderer omit entries that duplicate reserved keys it already emits — "an
///      EVM-efficiency reduction, never a semantic one" — and **as of v9 this renderer takes that
///      allowance for every reserved key**, so on the on-chain lanes the manifest is empty and the
///      key is omitted entirely. v2–v8 made one exception, a `renderer`-represented `image`, on the
///      grounds that its entry contributed an on-chain-declared `mimeType`. It did not: the value is
///      a `data:` URI, which states its own mediatype, so the entry's whole contribution was a
///      second copy of the image inside the same document — then base64-encoded again with it. On
///      the on-chain-SVG lane that roughly doubled the inner payload of the read this protocol most
///      wants to keep cheap. Locator/custody representations were already omitted (no honest
///      on-chain type to declare), and a `renderer` `animation_url` always was (same doubling,
///      larger document). Future sources (the staged `files` field, effect write-back locator
///      params) are additive in a later spec version.
/// @dev v3 adds the authorship + rights reserved collection fields to `contractURI` —
///      `creator`, `display_notes`, `creator_links`, `license` — each an optional text field
///      (omitted when unset), so fully-on-chain projects surface them without a dedicated
///      extension. These are reserved On-Chain Metadata keys, not events of their own.
/// @dev **Params are NOT in `tokenURI`.** v4 added an `abx_params` object here and v8 removed it.
///      It was emitted by this renderer AND by the off-chain resolver and read back by nobody: the
///      params store is enumerable on chain ({IAbxParams.tokenParamKeys} /
///      {IAbxParams.contractParamKeys} / {IAbxConfigurableParams.paramSchemaKeys}), which is
///      canonical, needs no indexer, and is what a chain-only reader should use; a code project's
///      script receives them through `tokenData`. So the projection was a third serialization of
///      data available two better ways — uncapped in size, quadratic to build, and duplicated across
///      two implementations, which is exactly the sibling drift that let a computed `image` locator
///      be data-wrapped on one path and not the other. Traits meant for marketplaces go in
///      `attributes`.
///
/// @dev Version history, because each bump changed what the document CONTAINS and `isCurrentRenderer`
///      gates on it: v5 escaped the provenance `note`; v6 changed rendered output for hostile input;
///      v7 renamed the `artist` collection field to `creator`; v8 removed `abx_params`, dropped
///      `onChain`/`verifiedAgainstChain` from `abx_provenance`, and made a computed `text/uri-list`
///      locator land verbatim for `image` as it already did for `animation_url`; v9 stopped
///      duplicating a computed `image` into `artifacts` (so the manifest key no longer appears on
///      the on-chain lanes) and deleted three orphaned `abx_params`-era param getters; v10 started
///      projecting four reserved keys the spec had always listed and this renderer never emitted —
///      `background_color` and `youtube_url` on the token, `banner_image` and `featured_image` on
///      the collection — and deleted the last four `abx_params`-era constants; v11 finished the
///      `ipfs` / `arweave` projection (below), which moves two representations out of the
///      fallback set and into the document.
///
/// @dev **v11 — `ipfs` / `arweave` resolve on-chain, through a gateway the collection chooses.**
///      The spec said "CID/txid encoding is a later spec version" and that was a fig leaf: the
///      values were already UTF-8 CID / txid strings, and the canonical generator had wrapped
///      directory `code` roots for as long as it had existed. The renderer never learned the wrap,
///      so the two representations that are content-addressed — the two where the locator IS the
///      integrity hash, the ones this protocol tells creators to prefer — were the two it could not
///      serve. The visible cost was that `abx deploy --onchain-uri --backend ipfs|arweave` had to
///      bake a gateway HOST into a `url` field to produce a renderable document, which welded a
///      hostname the creator could then never migrate and made `abx_provenance` report
///      `source: url` for bytes that live on IPFS. The chain stopped saying what was true.
///
///      Emitting a raw `ipfs://` would have been the easy wrong answer — browsers, wallets and most
///      marketplaces do not dereference it. So the real question was never the encoding; it was
///      WHOSE https, and WHEN it is bound. The answer splits the two facts that the baked URL had
///      fused: the CID/txid stays identity, in the field, under that field's own lock; the serving
///      prefix is a project-wide preference, in the two reserved COLLECTION-scope fields
///      {F_GATEWAY_IPFS} / {F_GATEWAY_ARWEAVE}, with the public floors as the fallback. A dead or
///      slow gateway is then a REPOINT — one `setContractField`, one ERC-4906 ping, every token
///      moved — and never a rewrite of `image` and never a rot.
///
///      Art Blocks V3 Flex kept the same two facts apart (`preferredIPFSGateway` on the core, the
///      CID on the asset) but left the concatenation to the artist's script, which is right for an
///      asset the PROGRAM loads and wrong for the `image` a MARKETPLACE reads. Here the renderer is
///      the concatenator, so a wallet gets an `https://` without the piece having to know a gateway.
///
///      Those two keys are a serving preference and NOT metadata: nothing projects them into
///      `tokenURI` or `contractURI` (this renderer emits a fixed key list), and the off-chain
///      resolver excludes them from the data plane's `artifacts` listing. Storing them in the field
///      store rather than as new token getters is what kept this a two-singleton change: the store
///      already gives an owner-gated setter, a `ContractFieldSet` event, the ERC-4906 ping and a
///      per-field freeze on all six token kinds, so no token implementation, factory, or
///      `initialize` ABI moved. (`SeriesCode` had 862 bytes of EIP-170 headroom; the getter pair the
///      design first called for measured 909.)
///
/// @dev **Which keys this renderer projects, and which are the resolver's alone.** The field store is
///      one; serving is two planes, and they are not meant to match key-for-key. This renderer emits
///      what a chain-reachable representation can produce (`inline` / `reader` / `renderer` / `url` /
///      `url-template`), falling back or omitting otherwise and saying which in `abx_provenance`. The
///      off-chain resolver may add what an `eth_call` cannot: `abx_provenance.status` (re-hashing
///      gateway bytes is off-chain work), the operator `display.*` overlay, effect and live-view
///      seams, the `artifacts` listing, a collection `image` courtesy drawn from a representative
///      token (a contract has no token id on `contractURI`), `image_data`, and any value behind an
///      off-chain load or decode (`keccak256` / `sha256` / `*-gzip`).
///      The maintained metadata documentation carries the authoritative three-list table. What must
///      NOT happen is the two planes disagreeing on a key BOTH can emit — that sibling drift is what
///      produced the computed-`image` wrapping bug and the `abx_params` duplication.
/// @dev **v5:** the `abx_provenance` `note` is JSON-escaped. Before it was not,
///      and `note` carries up to 32 raw bytes of a field's owner-chosen `representation` — enough to
///      close the JSON string and write new structure: 23 bytes flipped `onChain` from false to true
///      while keeping the document valid, 28 injected a top-level `"image"` that shadowed the real
///      one, and a single `"` made `tokenURI` unparseable for every consumer. A provenance block the
///      party it exists to hold accountable can rewrite is worse than none, so this is a version bump
///      and not a silent patch: a project pointed at a v4 renderer must be able to tell.
contract AbxMetadataRenderer is IAbxMetadataRenderer {
    uint256 private constant SPEC_VERSION = 11;

    /// @dev The tokenId a field renderer receives for collection-surface reads (no token).
    uint256 private constant COLLECTION_TOKEN_ID = type(uint256).max;

    // field tags — bytes32 string literals mirroring the off-chain METADATA_FIELD vocab.
    bytes32 private constant F_NAME = "name";
    bytes32 private constant F_DESCRIPTION = "description";
    bytes32 private constant F_IMAGE = "image";
    bytes32 private constant F_ANIMATION_URL = "animation_url";
    bytes32 private constant F_EXTERNAL_URL = "external_url";
    bytes32 private constant F_ATTRIBUTES = "attributes";
    bytes32 private constant F_BACKGROUND_COLOR = "background_color";
    bytes32 private constant F_YOUTUBE_URL = "youtube_url";
    bytes32 private constant F_EXTERNAL_LINK = "external_link";
    bytes32 private constant F_BANNER_IMAGE = "banner_image";
    bytes32 private constant F_FEATURED_IMAGE = "featured_image";
    // authorship + rights (collection scope) — reserved fields, projected into contractURI (v3).
    bytes32 private constant F_CREATOR = "creator";
    bytes32 private constant F_DISPLAY_NOTES = "display_notes";
    bytes32 private constant F_CREATOR_LINKS = "creator_links";
    bytes32 private constant F_LICENSE = "license";

    // reserved tokenData coordinates — never enumerated as params (the params store already
    // excludes `seed` from its key lists; the rest are defensive against a hostile list).

    // representation tags this renderer can resolve on-chain.
    bytes32 private constant R_INLINE = "inline";
    bytes32 private constant R_READER = "reader";
    bytes32 private constant R_RENDERER = "renderer";
    bytes32 private constant R_URL = "url";
    bytes32 private constant R_URL_TEMPLATE = "url-template";
    bytes32 private constant R_IPFS = "ipfs";
    bytes32 private constant R_ARWEAVE = "arweave";

    // Reserved COLLECTION-scope fields carrying the project's preferred gateway prefixes (v11).
    // A serving preference, not metadata: never projected into `tokenURI` / `contractURI`, and
    // excluded from the data plane's `artifacts` listing on the off-chain side. Owner-settable
    // through the field store's existing `setContractField` (owner-gated, `ContractFieldSet`,
    // ERC-4906 `BatchMetadataUpdate`) and freezable per field, so this needed no token-contract
    // surface of its own.
    bytes32 private constant F_GATEWAY_IPFS = "abx_gateway_ipfs";
    bytes32 private constant F_GATEWAY_ARWEAVE = "abx_gateway_arweave";

    /// @dev The public floors, used when a collection states no preference. Constants rather
    ///      than constructor args so the renderer stays argument-free and `predictRenderer()`
    ///      remains `CREATE2(salt, creationCode)` with nothing appended.
    string private constant FLOOR_IPFS = "https://ipfs.io/ipfs/";
    string private constant FLOOR_ARWEAVE = "https://arweave.net/";

    /// @dev The content type inline/`reader` `animation_url` bytes are wrapped with (v4) —
    ///      the twin of the SVG assumption inline/`reader` `image` bytes already ride.
    string private constant CT_HTML = "text/html";

    /// @inheritdoc IAbxMetadataRenderer
    function specVersion() external pure returns (uint256) {
        return SPEC_VERSION;
    }

    // ── token metadata (ERC-721 JSON) ────────────────────────────────────────--

    /// @inheritdoc IAbxMetadataRenderer
    function tokenURI(address token, uint256 tokenId) external view returns (string memory) {
        // required: name + image (always resolve to something)
        (string memory nameVal, string memory nameProv) = _resolveName(token, tokenId);
        (string memory imageVal, string memory imageProv, string memory artifacts) =
            _resolveImage(token, tokenId);

        string memory json = string.concat(
            '{"name":"',
            LibString.escapeJSON(nameVal),
            '","image":"',
            LibString.escapeJSON(imageVal),
            '"'
        );
        string memory prov = string.concat(nameProv, ",", imageProv);

        // optional text fields → omit when unset (or unrenderable).
        (json, prov) = _appendText(token, tokenId, F_DESCRIPTION, "description", json, prov);
        (json, prov) = _appendText(token, tokenId, F_EXTERNAL_URL, "external_url", json, prov);
        (json, prov) = _appendText(token, tokenId, F_ANIMATION_URL, "animation_url", json, prov);
        // v10: two more reserved token keys the spec has always listed and this renderer never
        // projected — a documented reserved key that neither surface emits is a protocol hole, not a
        // saved byte. Both are short strings, so `_appendText` already knows how, and the renderer
        // has ~14 KB of EIP-170 margin: size was never the reason they were missing.
        (json, prov) = _appendText(token, tokenId, F_BACKGROUND_COLOR, "background_color", json, prov);
        (json, prov) = _appendText(token, tokenId, F_YOUTUBE_URL, "youtube_url", json, prov);

        // optional attributes → embed inline JSON verbatim when present.
        (json, prov) = _appendAttributes(token, tokenId, json, prov);

        // the data plane's manifest — emitted only when non-empty (no boilerplate).
        if (bytes(artifacts).length != 0) {
            json = string.concat(json, ',"artifacts":[', artifacts, "]");
        }

        return _jsonDataUri(string.concat(json, ',"abx_provenance":[', prov, "]}"));
    }

    // ── collection metadata (ERC-7572 JSON) ──────────────────────────────────--

    /// @inheritdoc IAbxMetadataRenderer
    function contractURI(address token) external view returns (string memory) {
        // required: name (fallback = the ERC-721 collection name). image is omitted by spec.
        (bytes32 rep, bytes memory value) = IAbxOnChainMetadata(token).contractField(F_NAME);
        string memory nameVal;
        string memory prov;
        if (value.length != 0 && (rep == R_INLINE || rep == R_READER)) {
            nameVal = _text(rep, value);
            prov = _prov("name", rep == R_INLINE ? "inline" : "reader", _sourceNote(rep));
        } else {
            // ERC-721 collection name is on-chain storage → reconstructable from chain alone.
            nameVal = ICollectionName(token).name();
            prov = _prov("name", "fallback", "on-chain (ERC-721 name())");
        }

        string memory json = string.concat('{"name":"', LibString.escapeJSON(nameVal), '"');
        (json, prov) = _appendContractText(token, F_DESCRIPTION, "description", json, prov);
        (json, prov) = _appendContractText(token, F_EXTERNAL_LINK, "external_link", json, prov);
        // authorship + rights — optional reserved collection fields (omitted when unset).
        (json, prov) = _appendContractText(token, F_CREATOR, "creator", json, prov);
        (json, prov) = _appendContractText(token, F_DISPLAY_NOTES, "display_notes", json, prov);
        (json, prov) = _appendContractText(token, F_CREATOR_LINKS, "creator_links", json, prov);
        (json, prov) = _appendContractText(token, F_LICENSE, "license", json, prov);
        // v10: the two reserved COLLECTION image keys, same omission as the token pair above. Locators
        // or inline strings either way, so `_appendContractText` handles them; `url-template` is
        // meaningless at collection scope and it already omits that.
        (json, prov) = _appendContractText(token, F_BANNER_IMAGE, "banner_image", json, prov);
        (json, prov) = _appendContractText(token, F_FEATURED_IMAGE, "featured_image", json, prov);

        return _jsonDataUri(string.concat(json, ',"abx_provenance":[', prov, "]}"));
    }

    // ── field resolution ──────────────────────────────────────────────────────

    /// @dev Read a token field with COLLECTION-scope fallback: token scope first, else the
    ///      contract-wide field. `fromCollection` is true when the value came from the
    ///      collection scope (both empty → returns empty, `fromCollection` false).
    function _field(address token, uint256 tokenId, bytes32 field)
        private
        view
        returns (bytes32 rep, bytes memory value, bool fromCollection)
    {
        (rep, value) = IAbxOnChainMetadata(token).tokenField(tokenId, field);
        if (value.length != 0) return (rep, value, false);
        (bytes32 crep, bytes memory cval) = IAbxOnChainMetadata(token).contractField(field);
        if (cval.length != 0) return (crep, cval, true);
        return (rep, value, false);
    }

    /// @dev Required `name`: on-chain value (token→collection) if renderable, else
    ///      `"{collection name} #{id}"`.
    function _resolveName(address token, uint256 tokenId)
        private
        view
        returns (string memory value, string memory prov)
    {
        (bytes32 rep, bytes memory v, bool fromColl) = _field(token, tokenId, F_NAME);
        if (v.length != 0 && (rep == R_INLINE || rep == R_READER)) {
            return (
                _text(rep, v),
                _prov(
                    "name",
                    rep == R_INLINE ? "inline" : "reader",
                    _scopeNote(_sourceNote(rep), fromColl)
                )
            );
        }
        if (v.length != 0 && rep == R_RENDERER) {
            (, bytes memory data) = _renderField(v, token, tokenId, F_NAME);
            return (
                string(data),
                _prov("name", "renderer", _scopeNote(_sourceNote(rep), fromColl))
            );
        }
        // The ERC-721 collection name lives in on-chain contract storage and the tokenId is
        // on-chain, so the composed `{name} #{id}` is fully reconstructable from chain alone —
        // onChain is true. `source: "fallback"` only means "not from the metadata field store."
        string memory composed =
            string.concat(ICollectionName(token).name(), " #", LibString.toString(tokenId));
        return (composed, _prov("name", "fallback", "on-chain (ERC-721 name() + #id)"));
    }

    /// @dev Required `image`: a `data:` URI / locator if renderable on-chain (token→collection),
    ///      else a deterministic fallback SVG. Inline/reader bytes are treated as SVG (v1).
    ///      `artifact` (v2) is a data-plane manifest entry for the `renderer` representation —
    ///      the one whose mimeType is declared on-chain (the staticcall returns it); every other
    ///      case returns it empty (the spec's MAY-omit for reserved-key duplicates).
    function _resolveImage(address token, uint256 tokenId)
        private
        view
        returns (string memory uri, string memory prov, string memory artifact)
    {
        (bytes32 rep, bytes memory v, bool fromColl) = _field(token, tokenId, F_IMAGE);
        if (v.length != 0) {
            if (rep == R_INLINE) {
                return (
                    _svgDataUri(v),
                    _prov("image", "inline", _scopeNote(_sourceNote(R_INLINE), fromColl)),
                    ""
                );
            }
            if (rep == R_READER) {
                return (
                    _svgDataUri(_readViaReader(v)),
                    _prov("image", "reader", _scopeNote(_sourceNote(R_READER), fromColl)),
                    ""
                );
            }
            if (rep == R_URL) {
                return (
                    string(v),
                    _prov("image", "url", _scopeNote(_sourceNote(R_URL), fromColl)
                    ),
                    ""
                );
            }
            if (rep == R_URL_TEMPLATE) {
                return (
                    _applyTemplate(v, tokenId),
                    _prov("image", "url-template", _scopeNote(_sourceNote(R_URL_TEMPLATE), fromColl)
                    ),
                    ""
                );
            }
            if (rep == R_IPFS || rep == R_ARWEAVE) {
                string memory wrapped = _gatewayUrl(token, rep, v, tokenId, true);
                if (bytes(wrapped).length != 0) {
                    return (
                        wrapped,
                        _prov(
                            "image", _sourceOf(rep), _scopeNote(_sourceNote(rep), fromColl)
                        ),
                        ""
                    );
                }
            }
            if (rep == R_RENDERER) {
                (string memory val,,) = _computedField(v, token, tokenId, F_IMAGE, true);
                // NO `artifacts` entry, in either direction, and for two different reasons that
                // happen to agree.
                //
                // A computed LOCATOR declares the POINTER's type, not the content's — there is no
                // honest `mimeType` to put in the manifest.
                //
                // Computed CONTENT used to get an entry, which meant the whole base64 data URI was
                // emitted TWICE — once as `image`, once inside `artifacts` — and then the entire
                // document was base64-encoded around both. On the on-chain-SVG lane that roughly
                // doubled the inner payload of the exact read this protocol most wants to stay
                // cheap. The data-plane rules allow an on-chain renderer to
                // omit entries that duplicate reserved keys it already emits — "an EVM-efficiency
                // reduction, never a semantic one". Nothing is lost by taking it, because a
                // `data:` URI already carries its own mediatype; the duplicate entry's only unique
                // contribution was a `mimeType` the value states about itself.
                return (
                    val,
                    _prov("image", "renderer", _scopeNote(_sourceNote(rep), fromColl)),
                    ""
                );
            }
            // present, but this representation isn't on-chain-renderable here.
            return (
                _fallbackImage(token, tokenId),
                _prov("image", "fallback", _unrenderableNote(rep)),
                ""
            );
        }
        return (
            _fallbackImage(token, tokenId),
            _prov("image", "fallback", "fallback - image field unset"),
            ""
        );
    }

    /// @dev Append an optional token text field (token→collection scope) to `json`/`prov`;
    ///      omit when unset or unrenderable (noting the omission when a value existed).
    function _appendText(
        address token,
        uint256 tokenId,
        bytes32 field,
        string memory key,
        string memory json,
        string memory prov
    ) private view returns (string memory, string memory) {
        (bytes32 rep, bytes memory v, bool fromColl) = _field(token, tokenId, field);
        if (v.length == 0) return (json, prov); // unset → silently omit
        if (rep == R_INLINE || rep == R_READER) {
            // `animation_url` is URI-valued: stored bytes ARE the document, so they wrap as a
            // data: URI exactly as `image` does (v4). Every other text field carries its bytes.
            string memory val = _text(rep, v);
            if (field == F_ANIMATION_URL) val = _dataUri(CT_HTML, bytes(val));
            json = string.concat(json, ',"', key, '":"', LibString.escapeJSON(val), '"');
            prov = string.concat(
                prov, ",", _prov(key, _sourceOf(rep), _scopeNote(_sourceNote(rep), fromColl))
            );
        } else if (rep == R_URL || rep == R_URL_TEMPLATE || rep == R_IPFS || rep == R_ARWEAVE) {
            string memory val;
            if (rep == R_IPFS || rep == R_ARWEAVE) {
                val = _gatewayUrl(token, rep, v, tokenId, true);
                // `ipfs://` with nothing after it is a locator that locates nothing — omit it
                // rather than emit a bare gateway prefix that 404s.
                if (bytes(val).length == 0) {
                    return (json, string.concat(prov, ",", _prov(key, "omitted", _unrenderableNote(rep))));
                }
            } else {
                val = rep == R_URL_TEMPLATE ? _applyTemplate(v, tokenId) : string(v);
            }
            json = string.concat(json, ',"', key, '":"', LibString.escapeJSON(val), '"');
            prov = string.concat(
                prov,
                ",",
                _prov(key, _sourceOf(rep), _scopeNote(_sourceNote(rep), fromColl))
            );
        } else if (rep == R_RENDERER) {
            // computed: URI-valued fields become a data: URI; text fields carry the bytes.
            // EXCEPTION — contentType `text/uri-list` (RFC 2483: "this payload is a URI"):
            // the computed bytes ARE a locator and land VERBATIM as the field's value, never
            // data-wrapped, so a renderer-computed URL (e.g. the canonical generator's
            // directory branch) stays dereferenceable to marketplaces. Coherent across every
            // text field this path serves.
            (string memory val,,) =
                _computedField(v, token, tokenId, field, field == F_ANIMATION_URL);
            json = string.concat(json, ',"', key, '":"', LibString.escapeJSON(val), '"');
            prov = string.concat(
                prov, ",", _prov(key, "renderer", _scopeNote(_sourceNote(rep), fromColl))
            );
        } else {
            // present but unrenderable on-chain → omit the field, record why.
            prov = string.concat(prov, ",", _prov(key, "omitted", _unrenderableNote(rep)));
        }
        return (json, prov);
    }

    /// @dev Append optional `attributes` (token→collection scope) — embedded verbatim only when
    ///      carried as inline JSON.
    function _appendAttributes(
        address token,
        uint256 tokenId,
        string memory json,
        string memory prov
    ) private view returns (string memory, string memory) {
        (bytes32 rep, bytes memory v, bool fromColl) = _field(token, tokenId, F_ATTRIBUTES);
        if (v.length == 0) return (json, prov);
        if (rep == R_INLINE) {
            // RAW JSON, verbatim and unvalidated — that is what `inline` MEANS for this field.
            // `attributes` is an array, so it cannot be a quoted string, so there is nothing to
            // escape: the owner is writing JSON directly into the document by design.
            //
            // A malformed value therefore breaks the document, and a value like `[…],"image":"…"`
            // appends a sibling member that a last-wins parser prefers. Both are the OWNER doing
            // something to their OWN collection, and neither reaches anything they could not do
            // more directly — `image` is a field they already set. Structure-checking this on chain
            // would mean a JSON parser in Solidity to prevent a creator from misrepresenting their
            // own project, which is a trust question, not a protocol one. See
            // `site/content/docs/protocol/owner-powers.mdx`.
            json = string.concat(json, ',"attributes":', string(v));
            prov = string.concat(
                prov,
                ",",
                _prov("attributes", "inline", _scopeNote(_sourceNote(R_INLINE), fromColl))
            );
        } else if (rep == R_RENDERER) {
            // computed trait array — embedded verbatim (contentType application/json by convention)
            (, bytes memory data) = _renderField(v, token, tokenId, F_ATTRIBUTES);
            // An empty render would splice to `,"attributes":,` — not "the owner wrote something
            // odd", but no value at all in a position that requires one, giving a document no parser
            // can read. Omit the field instead, which is what every other unrenderable value does
            // here. One length check, and it turns a silent brick into a missing field.
            if (data.length == 0) return (json, prov);
            // the RENDERED bytes are the array here, not `v` (which encodes the renderer address)
            json = string.concat(json, ',"attributes":', string(data));
            prov = string.concat(
                prov,
                ",",
                _prov("attributes", "renderer", _scopeNote(_sourceNote(rep), fromColl))
            );
        } else {
            prov = string.concat(
                prov, ",", _prov("attributes", "omitted", _unrenderableNote(rep))
            );
        }
        return (json, prov);
    }

    /// @dev Collection-scope counterpart of {_appendText} (ERC-7572, no tokenId → no template).
    function _appendContractText(
        address token,
        bytes32 field,
        string memory key,
        string memory json,
        string memory prov
    ) private view returns (string memory, string memory) {
        (bytes32 rep, bytes memory v) = IAbxOnChainMetadata(token).contractField(field);
        if (v.length == 0) return (json, prov);
        if (rep == R_INLINE || rep == R_READER || rep == R_URL) {
            json = string.concat(json, ',"', key, '":"', LibString.escapeJSON(_text(rep, v)), '"');
            prov = string.concat(
                prov, ",", _prov(key, _sourceOf(rep), _sourceNote(rep))
            );
        } else if (rep == R_IPFS || rep == R_ARWEAVE) {
            // No tokenId on the collection surface, so no `{id}` substitution — the same reason
            // `url-template` is omitted here.
            string memory val = _gatewayUrl(token, rep, v, COLLECTION_TOKEN_ID, false);
            if (bytes(val).length == 0) {
                return (json, string.concat(prov, ",", _prov(key, "omitted", _unrenderableNote(rep))));
            }
            json = string.concat(json, ',"', key, '":"', LibString.escapeJSON(val), '"');
            prov = string.concat(prov, ",", _prov(key, _sourceOf(rep), _sourceNote(rep)));
        } else if (rep == R_RENDERER) {
            // collection surface has no token — the sentinel id tells the renderer so.
            (, bytes memory data) = _renderField(v, token, COLLECTION_TOKEN_ID, field);
            json = string.concat(json, ',"', key, '":"', LibString.escapeJSON(string(data)), '"');
            prov = string.concat(prov, ",", _prov(key, "renderer", _sourceNote(rep)));
        } else {
            prov = string.concat(prov, ",", _prov(key, "omitted", _unrenderableNote(rep)));
        }
        return (json, prov);
    }

    /// @dev Project a content-addressed locator (`ipfs` / `arweave`) into the `https://` URL a
    ///      marketplace or wallet can actually dereference. The CID/txid stays identity; the
    ///      serving prefix is the collection's, so a dead or slow gateway is a REPOINT (one
    ///      `setContractField`, one ERC-4906 ping) and never a rewrite of `image`.
    ///
    ///      Emitting a raw `ipfs://` here is the easy wrong answer — browsers, wallets and most
    ///      marketplaces do not resolve it — which is why this representation used to fall back
    ///      instead, and why `--onchain-uri --backend ipfs` had to bake a gateway host into a
    ///      `url` field and misreport its own provenance as `source: url`.
    ///
    ///      Order matters: strip the scheme, THEN template, THEN check for an absolute URL. A
    ///      value that already names its own host is emitted verbatim — never double-prefixed.
    /// @param template whether `{id}` substitution applies (false on the collection surface,
    ///        which has no tokenId — the same reason `url-template` is omitted there).
    /// @return The https URL, or the empty string when the value locates nothing (caller omits).
    function _gatewayUrl(
        address token,
        bytes32 rep,
        bytes memory v,
        uint256 tokenId,
        bool template
    ) private view returns (string memory) {
        string memory id = string(v);
        if (rep == R_IPFS) {
            if (LibString.startsWith(id, "ipfs://")) id = LibString.slice(id, 7);
        } else if (LibString.startsWith(id, "ar://")) {
            id = LibString.slice(id, 5);
        }
        if (bytes(id).length == 0) return "";
        // One collection-scope `ipfs` field addresses a whole pinned directory (`<cid>/{id}.png`),
        // the O(1) series pattern `url-template` already serves for non-content-addressed hosts.
        if (template) id = LibString.replace(id, "{id}", LibString.toString(tokenId));
        if (LibString.startsWith(id, "https://") || LibString.startsWith(id, "http://")) return id;
        return string.concat(_gatewayPrefix(token, rep), id);
    }

    /// @dev The collection's preferred gateway prefix for a scheme, else the public floor. Read
    ///      from the reserved COLLECTION-scope field only: a gateway is a project-wide serving
    ///      preference, so there is deliberately no token-scope override to disagree with it.
    ///      Only an `inline` value counts — a prefix is a short UTF-8 string, and accepting one
    ///      representation keeps this rule identical on both serving planes.
    function _gatewayPrefix(address token, bytes32 rep) private view returns (string memory) {
        (bytes32 grep, bytes memory gv) = IAbxOnChainMetadata(token).contractField(
            rep == R_IPFS ? F_GATEWAY_IPFS : F_GATEWAY_ARWEAVE
        );
        if (gv.length != 0 && grep == R_INLINE) return string(gv);
        return rep == R_IPFS ? FLOOR_IPFS : FLOOR_ARWEAVE;
    }

    /// @dev Substitute the decimal `tokenId` for every `{id}` in a URL template.
    function _applyTemplate(bytes memory tmpl, uint256 tokenId)
        private
        pure
        returns (string memory)
    {
        return LibString.replace(string(tmpl), "{id}", LibString.toString(tokenId));
    }

    /// @dev Decode an inline/reader text value to a string (reader → call read(pointer)).
    function _text(bytes32 rep, bytes memory v) private view returns (string memory) {
        return rep == R_READER ? string(_readViaReader(v)) : string(v);
    }

    /// @dev A `reader` field's value is `abi.encode(address reader, address pointer)`.
    function _readViaReader(bytes memory v) private view returns (bytes memory) {
        (address reader, address pointer) = abi.decode(v, (address, address));
        return IAbxOnChainReader(reader).read(pointer);
    }

    /// @dev A `renderer` field's value is `abi.encode(address fieldRenderer)` — computed bytes.
    function _renderField(bytes memory v, address token, uint256 tokenId, bytes32 field)
        private
        view
        returns (string memory contentType, bytes memory data)
    {
        address fieldRenderer = abi.decode(v, (address));
        return IAbxFieldRenderer(fieldRenderer).render(token, tokenId, field);
    }

    /// @dev A field computed by a field renderer, resolved to its final string. THE one
    ///      implementation of the URI-valued rule — `image` and `animation_url` each had their own
    ///      and only one of them honored it, so a computed `image` locator came out as
    ///      `data:text/uri-list;base64,…`, which no marketplace dereferences.
    ///
    ///      `text/uri-list` (RFC 2483: "this payload is a URI") is the renderer DECLARING that it
    ///      computed a locator rather than content. That is a content type we are told, not a string
    ///      we inspect — the renderer never parses a value to guess what it points at.
    /// @param uriValued whether this field's value must be dereferenceable (`image`,
    ///        `animation_url`). Text fields carry their bytes raw either way.
    function _computedField(
        bytes memory v,
        address token,
        uint256 tokenId,
        bytes32 field,
        bool uriValued
    ) private view returns (string memory value, string memory contentType, bool isLocator) {
        bytes memory data;
        (contentType, data) = _renderField(v, token, tokenId, field);
        isLocator = LibString.eq(contentType, "text/uri-list");
        value = (uriValued && !isLocator) ? _dataUri(contentType, data) : string(data);
    }

    /// @dev `contentType` is taken verbatim from the field renderer. A `data:` URL's mediatype ends
    ///      at the first comma, so a renderer returning `text/html,<script>…` would make the markup
    ///      the payload rather than the base64 that follows. That renderer is a contract the project
    ///      owner chose and pointed this field at — an owner who wants script in their own
    ///      `animation_url` can put it there directly, so constraining the string here would buy
    ///      nothing and cost every render. Trust boundary, not a validation gap.
    function _dataUri(string memory contentType, bytes memory data)
        private
        pure
        returns (string memory)
    {
        return string.concat("data:", contentType, ";base64,", Base64.encode(data));
    }


    /// @dev One `artifacts` manifest entry — exactly `{key, mimeType, uri}`, nothing optional.
    function _artifactEntry(string memory key, string memory mimeType, string memory uri)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '{"key":"',
            key,
            '","mimeType":"',
            LibString.escapeJSON(mimeType),
            '","uri":"',
            LibString.escapeJSON(uri),
            '"}'
        );
    }

    function _svgDataUri(bytes memory svg) private pure returns (string memory) {
        return string.concat("data:image/svg+xml;base64,", Base64.encode(svg));
    }

    function _jsonDataUri(string memory json) private pure returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev Deterministic placeholder SVG — background from the address, label `#tokenId`.
    ///      Byte-identical to the off-chain resolver's `fallbackImageSvg`.
    function _fallbackImage(address token, uint256 tokenId) private pure returns (string memory) {
        string memory color = LibString.slice(LibString.toHexStringNoPrefix(token), 0, 6);
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500"><rect width="500" height="500" fill="#',
            color,
            '"/><text x="250" y="264" font-family="monospace" font-size="42" fill="#ffffff" text-anchor="middle">#',
            LibString.toString(tokenId),
            "</text></svg>"
        );
        return _svgDataUri(bytes(svg));
    }

    /// @dev `note` is JSON-escaped and must stay that way. `field` and `source` are internal
    ///      constants of this contract; `note` is not — it reaches here carrying up to 32 raw bytes
    ///      of a field's `representation`, which the project owner chooses freely (see
    ///      {_repName}/{_unrenderableNote}). Unescaped, that was enough room to close the string and
    ///      write new structure: 28 bytes injected a top-level `"image"` shadowing the real one, and a
    ///      single `"` made `tokenURI` unparseable for every consumer. (The original example here
    ///      was flipping `onChain` from false to true — that field is gone, the escaping is not.)
    ///
    ///      That mattered more than a generic injection because of *what* it forged. This block
    ///      exists so a collector, marketplace or indexer can tell whether a field genuinely
    ///      resolves from chain — a surface that can be rewritten by the party it is meant to hold
    ///      accountable is worse than no surface at all.
    /// @dev One `abx_provenance` entry: `{field, source, note}`.
    ///
    ///      **What this reports, and what it deliberately does not.** `source` says WHERE THE BYTES
    ///      CAME FROM — stored on chain, computed on chain, or composed on chain from a stored
    ///      template. It does not say whether those bytes RESOLVE on chain, because the contract
    ///      cannot know that without interpreting the value, and interpreting a value is off-chain
    ///      work.
    ///
    ///      There used to be an `onChain` boolean here, and it was wrong in both directions: a
    ///      `url` reported `false` even though the URL string is stored on chain, while an `inline`
    ///      value of `"https://example.com/x.png"` reported `true` for a pure pointer. It was trying
    ///      to answer a question no on-chain code can see. A `verifiedAgainstChain` field sat beside
    ///      it, hardcoded `null` on every entry.
    ///
    ///      So the honest report is: these bytes came from the chain, by this route. Whether a given
    ///      value is a fully self-contained `data:` URI or a pointer to something else is visible in
    ///      the value itself — that determination belongs to the reader, which can actually make it.
    function _prov(string memory field, string memory source, string memory note)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '{"field":"', field, '","source":"', source, '","note":"', LibString.escapeJSON(note), '"}'
        );
    }

    /// @dev Tag a provenance note with `[collection]` when the value came from collection scope.
    function _scopeNote(string memory note, bool fromCollection)
        private
        pure
        returns (string memory)
    {
        return fromCollection ? string.concat(note, " [collection]") : note;
    }

    function _sourceOf(bytes32 rep) private pure returns (string memory) {
        if (rep == R_INLINE) return "inline";
        if (rep == R_READER) return "reader";
        if (rep == R_RENDERER) return "renderer";
        if (rep == R_URL) return "url";
        if (rep == R_URL_TEMPLATE) return "url-template";
        if (rep == R_IPFS) return "ipfs";
        if (rep == R_ARWEAVE) return "arweave";
        return "omitted";
    }

    /// @dev How the bytes reached the document. `url`/`url-template` say "locator" because that is
    ///      what the REPRESENTATION means by construction — not because anything parsed the string.
    function _sourceNote(bytes32 rep) private pure returns (string memory) {
        if (rep == R_URL) return "stored on chain; the value is a locator";
        if (rep == R_URL_TEMPLATE) return "composed on chain from a stored template; a locator";
        if (rep == R_RENDERER) return "computed on chain (field renderer)";
        if (rep == R_IPFS || rep == R_ARWEAVE) {
            // Deliberately NOT a `verified` claim: the locator is on chain, the bytes are not,
            // and a contract cannot re-hash what a gateway serves.
            return "stored on chain; a content-addressed locator, served through the collection's preferred gateway";
        }
        return rep == R_READER ? "stored on chain (chunked)" : "stored on chain";
    }

    function _unrenderableNote(bytes32 rep) private pure returns (string memory) {
        return string.concat("representation not on-chain-renderable: ", _repName(rep));
    }

    /// @dev Best-effort readable tag for a `bytes32` representation (trailing zeros trimmed).
    function _repName(bytes32 rep) private pure returns (string memory) {
        uint256 len;
        while (len < 32 && rep[len] != 0) ++len;
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            uint8 c = uint8(rep[i]);
            // Printable ASCII only. A representation tag is owner-chosen `bytes32`, and
            // `LibString.escapeJSON` works byte-by-byte: it escapes the JSON metacharacters but
            // passes bytes >= 0x80 through untouched, so a tag carrying arbitrary high bytes made the
            // ENTIRE `tokenURI` invalid UTF-8 and strict parsers rejected the whole document — a
            // valid-JSON-but-unreadable failure that is worse than an omitted field. Substituting
            // keeps the diagnostic legible and the document decodable; a real tag is ASCII anyway.
            out[i] = (c >= 0x20 && c < 0x7F) ? bytes1(c) : bytes1("?");
        }
        return string(out);
    }
}
