// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {TokenURI} from "../src/uri/token/TokenURI.sol";
import {IAbxConfigurableParams} from
    "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice The on-chain metadata renderer end to end: the URI toggle, on-chain JSON
///         assembly from fields, the required-field fallbacks, and the config lock.
contract AbxMetadataRendererTest is Test {
    bytes32 internal constant NAME = "name";
    bytes32 internal constant DESCRIPTION = "description";
    bytes32 internal constant IMAGE = "image";
    bytes32 internal constant INLINE = "inline";
    bytes32 internal constant KECCAK256 = "keccak256";
    bytes32 internal constant URL = "url";
    bytes32 internal constant URL_TEMPLATE = "url-template";
    bytes32 internal constant IPFS = "ipfs";
    bytes32 internal constant ARWEAVE = "arweave";
    bytes32 internal constant ANIMATION_URL = "animation_url";
    bytes32 internal constant BANNER_IMAGE = "banner_image";
    bytes32 internal constant FEATURED_IMAGE = "featured_image";
    bytes32 internal constant GATEWAY_IPFS = "abx_gateway_ipfs";
    bytes32 internal constant GATEWAY_ARWEAVE = "abx_gateway_arweave";

    string internal constant JSON_PREFIX = "data:application/json;base64,";

    OneOfOneImageFactory internal factory;
    AbxMetadataRenderer internal renderer;
    address internal owner = makeAddr("owner");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");

    function setUp() public {
        factory = new OneOfOneImageFactory();
        renderer = new AbxMetadataRenderer();
    }

    // ---- helpers ----

    function _params(address tokenURIRenderer, IAbxOnChainMetadata.FieldInput[] memory tokenFields)
        internal
        view
        returns (OneOfOneImage.InitParams memory)
    {
        return OneOfOneImage.InitParams({
            owner: owner,
            mintTo: owner,
            name: "Sunrise",
            symbol: "SUN",
            tokenURIBase: "ipfs://off-chain-pointer",
            tokenURIRenderer: tokenURIRenderer,
            contractURIBase: "ipfs://off-chain-contract",
            contractURIRenderer: tokenURIRenderer,
            royaltyReceiver: royaltyReceiver,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            tokenFields: tokenFields,
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    function _field(bytes32 field, bytes32 rep, bytes memory value)
        internal
        pure
        returns (IAbxOnChainMetadata.FieldInput memory)
    {
        return IAbxOnChainMetadata.FieldInput({field: field, representation: rep, value: value});
    }

    /// @dev {_params} plus collection-scope fields (for the token→collection fallback tests).
    function _paramsC(
        address tokenURIRenderer,
        IAbxOnChainMetadata.FieldInput[] memory tokenFields,
        IAbxOnChainMetadata.FieldInput[] memory contractFields
    ) internal view returns (OneOfOneImage.InitParams memory p) {
        p = _params(tokenURIRenderer, tokenFields);
        p.contractFields = contractFields;
    }

    /// @dev Decode a `data:application/json;base64,...` URI to its JSON string.
    function _decodeJson(string memory uri) internal pure returns (string memory) {
        assertTrue(LibString.startsWith(uri, JSON_PREFIX), "not a json data uri");
        return string(Base64.decode(LibString.slice(uri, bytes(JSON_PREFIX).length)));
    }

    function _assertContains(string memory haystack, string memory needle) internal pure {
        assertTrue(LibString.contains(haystack, needle), needle);
    }

    /// @dev `n` distinct-ish bytes — content the base64/hash assertions can pin exactly.
    function _blob(uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = bytes1(uint8(i % 251));
        }
    }

    /// @dev The protocol off-chain pointer grammar (mirrors `TokenURI._composeTokenURI`):
    ///      `{base}/{chainId}/{address}/{tokenId}`, lowercase 0x-address.
    function _derived(address c, uint256 id, string memory base)
        internal
        view
        returns (string memory)
    {
        return string.concat(
            base,
            "/",
            LibString.toString(block.chainid),
            "/",
            LibString.toHexString(c),
            "/",
            LibString.toString(id)
        );
    }

    // ---- toggle ----

    function test_RendererUnset_ResolvesOffChainPointer() public {
        OneOfOneImage nft =
            OneOfOneImage(factory.deploy(_params(address(0), new IAbxOnChainMetadata.FieldInput[](0))));
        // off-chain ⇒ the pointer is DERIVED from the base via the protocol grammar.
        assertEq(nft.tokenURI(0), _derived(address(nft), 0, "ipfs://off-chain-pointer"));
        assertEq(nft.tokenURIRenderer(), address(0));
    }

    function test_RendererSet_ResolvesOnChainJson() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](2);
        f[0] = _field(DESCRIPTION, INLINE, bytes("A study in light."));
        f[1] = _field(IMAGE, INLINE, bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"name":"Sunrise #0"'); // required, fallback-composed
        _assertContains(json, '"description":"A study in light."'); // inline on-chain
        _assertContains(json, '"image":"data:image/svg+xml;base64,'); // inline SVG → data URI
        _assertContains(json, '"abx_provenance":['); // provenance present
        _assertContains(json, '"source":"inline"');
        // the name fallback is the ERC-721 name() + #id — on-chain storage, so onChain is true.
        _assertContains(json, '"field":"name","source":"fallback"');
        _assertContains(json, '"note":"on-chain (ERC-721 name() + #id)"');
    }

    // ---- required-field fallbacks ----

    function test_ImageUnset_FallsBackToDeterministicSvg() public {
        // a token with an on-chain renderer but NO image field set anywhere
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_params(address(renderer), new IAbxOnChainMetadata.FieldInput[](0)))
        );
        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"data:image/svg+xml;base64,'); // fallback image still present
        // image fallback stays onChain:false — it can mask genuinely off-chain content.
        _assertContains(json, '"field":"image","source":"fallback"'); // honest provenance
        _assertContains(json, '"name":"Sunrise #0"');
    }

    function test_ImageHashOnly_NotOnChainRenderable_FallsBack() public {
        // image carried as a keccak256 hash → off-chain custody; renderer can't load it.
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, KECCAK256, abi.encodePacked(keccak256("bytes")));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));
        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"data:image/svg+xml;base64,');
        _assertContains(json, "representation not on-chain-renderable: keccak256");
    }

    // ---- collection scope ----

    function test_ContractURI_OnChain() public {
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_params(address(renderer), new IAbxOnChainMetadata.FieldInput[](0)))
        );
        string memory json = _decodeJson(nft.contractURI());
        _assertContains(json, '"name":"Sunrise"'); // fallback = ERC-721 collection name (no #id)
        _assertContains(json, '"name","source":"fallback"'); // ERC-721 name() is on-chain
        _assertContains(json, '"note":"on-chain (ERC-721 name())"');
    }

    function test_ContractURI_AuthorshipAndLicense() public {
        // creator + license (v3): reserved collection fields, projected into contractURI when set.
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](2);
        cf[0] = _field("creator", "inline", bytes("Casey Reas"));
        cf[1] = _field("license", "inline", bytes("CC BY-NC 4.0"));
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_paramsC(address(renderer), new IAbxOnChainMetadata.FieldInput[](0), cf))
        );
        string memory json = _decodeJson(nft.contractURI());
        _assertContains(json, '"creator":"Casey Reas"');
        _assertContains(json, '"license":"CC BY-NC 4.0"');
    }

    function test_ContractURI_AuthorshipOmittedWhenUnset() public {
        // unset authorship/rights fields are simply absent (no boilerplate).
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_params(address(renderer), new IAbxOnChainMetadata.FieldInput[](0)))
        );
        string memory json = _decodeJson(nft.contractURI());
        assertFalse(LibString.contains(json, '"creator"'));
        assertFalse(LibString.contains(json, '"license"'));
    }

    // ---- url-template + collection-scope fallback (spec v1 directory-base) ----

    function test_ImageUrlTemplate_SubstitutesTokenId() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, URL_TEMPLATE, bytes("https://arweave.net/MANIFEST/{id}.png"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"https://arweave.net/MANIFEST/0.png"'); // {id} -> 0
        _assertContains(json, '"field":"image","source":"url-template"');
        _assertContains(json, "composed on chain from a stored template; a locator");
    }

    function test_CollectionScopeImage_CoversTokenViaFallback() public {
        // ONE collection-scope image field (no token field) covers the token — the O(1) directory
        // pattern. url-template substitutes {id}; provenance marks the collection source.
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](1);
        cf[0] = _field(IMAGE, URL_TEMPLATE, bytes("ipfs://DIRCID/{id}.png"));
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_paramsC(address(renderer), new IAbxOnChainMetadata.FieldInput[](0), cf))
        );

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"ipfs://DIRCID/0.png"');
        _assertContains(json, "composed on chain from a stored template; a locator [collection]");
    }

    function test_TokenScopeImage_OverridesCollection() public {
        IAbxOnChainMetadata.FieldInput[] memory tf = new IAbxOnChainMetadata.FieldInput[](1);
        tf[0] = _field(IMAGE, URL, bytes("https://token-specific/pic.png"));
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](1);
        cf[0] = _field(IMAGE, URL_TEMPLATE, bytes("ipfs://DIRCID/{id}.png"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_paramsC(address(renderer), tf, cf)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"https://token-specific/pic.png"'); // token wins
        _assertContains(json, '"field":"image","source":"url"');
        // token-scope value is NOT tagged [collection]
        assertFalse(
            LibString.contains(
                json,
                '"source":"url","note":"stored on chain; the value is a locator [collection]"'
            )
        );
    }

    function test_CollectionScopeDescription_CoversToken() public {
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](1);
        cf[0] = _field(DESCRIPTION, INLINE, bytes("Shared across the collection."));
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_paramsC(address(renderer), new IAbxOnChainMetadata.FieldInput[](0), cf))
        );

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"description":"Shared across the collection."');
        _assertContains(json, "stored on chain [collection]");
    }

    // ---- the `artifacts` manifest (data plane, spec v2) ----

    /// v9: a computed image is carried ONCE. Through v8 it was emitted as `image` and again inside
    /// `artifacts`, so the whole base64 still appeared twice in a document that is then base64-encoded
    /// around both — nearly doubling the inner payload of the on-chain-SVG lane's `tokenURI`. The
    /// entry's supposed contribution was an on-chain-declared `mimeType`, which a `data:` URI already
    /// states about itself, so nothing was lost by dropping it. The data-plane spec permits exactly
    /// this ("an EVM-efficiency reduction, never a semantic one").
    function test_RendererRepImage_CarriesTheStillExactlyOnce() public {
        FixedFieldRenderer fr = new FixedFieldRenderer("image/svg+xml", bytes("<svg/>"));
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, "renderer", abi.encode(address(fr)));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"data:image/svg+xml;base64,');
        // no manifest at all on this lane — the one entry class that used to exist is gone
        assertFalse(LibString.contains(json, '"artifacts"'), "artifacts must not appear");
        // and the still itself appears exactly once: count occurrences of the encoded payload
        string memory payload = "data:image/svg+xml;base64,";
        uint256 n;
        bytes memory jb = bytes(json);
        bytes memory pb = bytes(payload);
        for (uint256 i; i + pb.length <= jb.length; ++i) {
            bool hit = true;
            for (uint256 k; k < pb.length; ++k) {
                if (jb[i + k] != pb[k]) {
                    hit = false;
                    break;
                }
            }
            if (hit) ++n;
        }
        assertEq(n, 1, "the computed still must be carried exactly once");
    }

    function test_UriListImageRenderer_NoArtifactEntry() public {
        // a computed LOCATOR (text/uri-list) declares the pointer's type, not the content's —
        // no honest mimeType → no manifest entry.
        FixedFieldRenderer fr = new FixedFieldRenderer("text/uri-list", bytes("ipfs://Qm/x.png"));
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, "renderer", abi.encode(address(fr)));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));
        assertFalse(LibString.contains(_decodeJson(nft.tokenURI(0)), '"artifacts"'));
    }

    function test_NonRendererRepresentations_OmitArtifacts() public {
        // inline SVG / url-template / unset are reserved-key duplicates with no on-chain type
        // declaration — the reference renderer exercises the spec's MAY-omit (no boilerplate).
        IAbxOnChainMetadata.FieldInput[] memory inlineF = new IAbxOnChainMetadata.FieldInput[](1);
        inlineF[0] = _field(IMAGE, INLINE, bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
        OneOfOneImage inlineNft = OneOfOneImage(factory.deploy(_params(address(renderer), inlineF)));
        assertFalse(LibString.contains(_decodeJson(inlineNft.tokenURI(0)), '"artifacts"'));

        IAbxOnChainMetadata.FieldInput[] memory tmplF = new IAbxOnChainMetadata.FieldInput[](1);
        tmplF[0] = _field(IMAGE, URL_TEMPLATE, bytes("ipfs://DIRCID/{id}.png"));
        OneOfOneImage tmplNft = OneOfOneImage(factory.deploy(_params(address(renderer), tmplF)));
        assertFalse(LibString.contains(_decodeJson(tmplNft.tokenURI(0)), '"artifacts"'));

        OneOfOneImage bareNft = OneOfOneImage(
            factory.deploy(_params(address(renderer), new IAbxOnChainMetadata.FieldInput[](0)))
        );
        assertFalse(LibString.contains(_decodeJson(bareNft.tokenURI(0)), '"artifacts"'));
    }

    // ---- placement + the rest of the document ----

    // ---- animation_url wrapping (spec v4) ----

    function test_InlineAnimationUrl_WrappedAsDataHtml() public {
        bytes memory doc = bytes("<html><body>hi</body></html>");
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](2);
        f[0] = _field("animation_url", INLINE, doc);
        f[1] = _field(DESCRIPTION, INLINE, bytes("A study in light."));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(
            json,
            string.concat('"animation_url":"data:text/html;base64,', Base64.encode(doc), '"')
        );
        // the wrap is animation_url-only — other text fields still carry their bytes
        _assertContains(json, '"description":"A study in light."');
    }

    function test_ReaderAnimationUrl_WrappedAsDataHtml() public {
        bytes memory doc = bytes("<html><body>read</body></html>");
        FixedReader reader = new FixedReader(doc);
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field("animation_url", "reader", abi.encode(address(reader), address(0)));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        _assertContains(
            _decodeJson(nft.tokenURI(0)),
            string.concat('"animation_url":"data:text/html;base64,', Base64.encode(doc), '"')
        );
    }

    function test_RendererAnimationUrl_UnchangedByV4() public {
        bytes memory doc = bytes("<html>computed</html>");
        FixedFieldRenderer fr = new FixedFieldRenderer("text/html", doc);
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field("animation_url", "renderer", abi.encode(address(fr)));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        _assertContains(
            _decodeJson(nft.tokenURI(0)),
            string.concat('"animation_url":"data:text/html;base64,', Base64.encode(doc), '"')
        );
    }

    function test_UriListAnimationUrl_StillLandsVerbatim() public {
        // the computed-LOCATOR rule is untouched: never data-wrapped.
        FixedFieldRenderer fr =
            new FixedFieldRenderer("text/uri-list", bytes("https://gateway/x.html?abx=AA"));
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field("animation_url", "renderer", abi.encode(address(fr)));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        _assertContains(
            _decodeJson(nft.tokenURI(0)), '"animation_url":"https://gateway/x.html?abx=AA"'
        );
    }

    function test_UrlAnimationUrl_StillLandsVerbatim() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field("animation_url", URL, bytes("https://example.test/live"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));
        _assertContains(
            _decodeJson(nft.tokenURI(0)), '"animation_url":"https://example.test/live"'
        );
    }

    // ---- spec version + lock ----

    /// Named for the number on purpose: a version bump must be a deliberate edit here, not a
    /// silently-updated constant. 7 = the `artist` → `creator` rename, which changes the member key
    /// this renderer emits into every collection document. `isCurrentRenderer` is what stops a chain
    /// running the OLD renderer from reporting as current.
    function test_SpecVersionIsEleven() public view {
        assertEq(renderer.specVersion(), 11);
    }

    // ---- v10: the four reserved keys that were documented but projected by neither plane ----

    /// `background_color` and `youtube_url` are reserved TOKEN keys the spec has always listed. The
    /// renderer never grew the `_append*` calls, so a creator could set them on chain and no surface
    /// would ever emit them — a documented reserved key nothing serves is a protocol hole.
    function test_V10_TokenProjectsBackgroundColorAndYoutubeUrl() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](2);
        f[0] = _field("background_color", INLINE, bytes("1A1A2E"));
        f[1] = _field("youtube_url", URL, bytes("https://youtube.com/watch?v=abc123"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"background_color":"1A1A2E"');
        _assertContains(json, '"youtube_url":"https://youtube.com/watch?v=abc123"');
    }

    /// `banner_image` and `featured_image` are the reserved COLLECTION pair, same omission.
    function test_V10_CollectionProjectsBannerAndFeaturedImage() public {
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](2);
        cf[0] = _field("banner_image", URL, bytes("https://cdn.example/banner.png"));
        cf[1] = _field("featured_image", URL, bytes("https://cdn.example/featured.png"));
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_paramsC(address(renderer), new IAbxOnChainMetadata.FieldInput[](0), cf))
        );

        string memory json = _decodeJson(nft.contractURI());
        _assertContains(json, '"banner_image":"https://cdn.example/banner.png"');
        _assertContains(json, '"featured_image":"https://cdn.example/featured.png"');
    }

    /// Optional means optional: unset ⇒ the key is absent, not empty-stringed. This is the half that
    /// keeps the addition from bloating every document that does not use these fields.
    function test_V10_TheFourKeysAreOmittedWhenUnset() public {
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_params(address(renderer), new IAbxOnChainMetadata.FieldInput[](0)))
        );
        string memory tokenJson = _decodeJson(nft.tokenURI(0));
        assertFalse(LibString.contains(tokenJson, "background_color"), "background_color must be omitted");
        assertFalse(LibString.contains(tokenJson, "youtube_url"), "youtube_url must be omitted");
        string memory collJson = _decodeJson(nft.contractURI());
        assertFalse(LibString.contains(collJson, "banner_image"), "banner_image must be omitted");
        assertFalse(LibString.contains(collJson, "featured_image"), "featured_image must be omitted");
    }

    function test_LockTokenURI_BlocksRepointing() public {
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_params(address(renderer), new IAbxOnChainMetadata.FieldInput[](0)))
        );
        vm.prank(owner);
        nft.lockTokenURI();
        assertTrue(nft.tokenURILocked());

        vm.prank(owner);
        vm.expectRevert(TokenURI.TokenURIConfigLocked.selector);
        nft.setTokenURIRenderer(address(0));
    }

    function test_OwnerCanToggleRendererOnAndOff() public {
        OneOfOneImage nft =
            OneOfOneImage(factory.deploy(_params(address(0), new IAbxOnChainMetadata.FieldInput[](0))));
        assertEq(nft.tokenURI(0), _derived(address(nft), 0, "ipfs://off-chain-pointer")); // off-chain (derived)

        vm.prank(owner);
        nft.setTokenURIRenderer(address(renderer));
        assertTrue(LibString.startsWith(nft.tokenURI(0), JSON_PREFIX)); // now on-chain

        vm.prank(owner);
        nft.setTokenURIRenderer(address(0));
        assertEq(nft.tokenURI(0), _derived(address(nft), 0, "ipfs://off-chain-pointer")); // back to off-chain
    }

    // ---- v11: `ipfs` / `arweave` project through the collection's preferred gateway ----
    //
    // Before v11 these two representations FELL BACK — the only two that are content-addressed,
    // the two where the locator IS the integrity hash, and the two the protocol tells creators to
    // prefer. `--onchain-uri --backend ipfs` therefore baked a gateway HOST into a `url` field to
    // get a renderable document, welding a hostname the creator could never migrate and reporting
    // `source: url` for bytes that live on IPFS.

    function test_IpfsImage_WrapsWithThePublicFloor() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, IPFS, bytes("bafytestcid"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"https://ipfs.io/ipfs/bafytestcid"');
        _assertContains(json, '"field":"image","source":"ipfs"');
        // The whole point: a required `image` with an ipfs value is no longer a placeholder SVG.
        assertFalse(LibString.contains(json, "image/svg+xml"), "must not fall back");
    }

    function test_ArweaveImage_WrapsWithThePublicFloor() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, ARWEAVE, bytes("txidtxidtxid"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"https://arweave.net/txidtxidtxid"');
        _assertContains(json, '"field":"image","source":"arweave"');
    }

    /// A creator who stores the scheme prefix (what `abx attach ipfs://…` writes) and one who
    /// stores the bare CID must land on the same URL.
    function test_SchemePrefixIsStripped() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, IPFS, bytes("ipfs://bafytestcid"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));
        _assertContains(_decodeJson(nft.tokenURI(0)), '"image":"https://ipfs.io/ipfs/bafytestcid"');

        IAbxOnChainMetadata.FieldInput[] memory g = new IAbxOnChainMetadata.FieldInput[](1);
        g[0] = _field(IMAGE, ARWEAVE, bytes("ar://txidtxidtxid"));
        OneOfOneImage nft2 = OneOfOneImage(factory.deploy(_params(address(renderer), g)));
        _assertContains(_decodeJson(nft2.tokenURI(0)), '"image":"https://arweave.net/txidtxidtxid"');
    }

    function test_CollectionGatewayFieldOverridesTheFloor() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, IPFS, bytes("bafytestcid"));
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](1);
        cf[0] = _field(GATEWAY_IPFS, INLINE, bytes("https://dedicated.mypinata.cloud/ipfs/"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_paramsC(address(renderer), f, cf)));

        _assertContains(
            _decodeJson(nft.tokenURI(0)),
            '"image":"https://dedicated.mypinata.cloud/ipfs/bafytestcid"'
        );
    }

    /// A dead gateway is a REPOINT, not a rewrite of `image` — the reason the prefix is not welded
    /// into the field value in the first place.
    function test_GatewayRepointMovesEveryTokenWithoutTouchingTheCid() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, IPFS, bytes("bafytestcid"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));
        _assertContains(_decodeJson(nft.tokenURI(0)), '"image":"https://ipfs.io/ipfs/bafytestcid"');

        vm.prank(owner);
        nft.setContractField(GATEWAY_IPFS, INLINE, bytes("https://fast.example/ipfs/"));
        _assertContains(_decodeJson(nft.tokenURI(0)), '"image":"https://fast.example/ipfs/bafytestcid"');

        // and the identity never moved
        (bytes32 rep, bytes memory v) = nft.tokenField(0, IMAGE);
        assertEq(rep, IPFS);
        assertEq(string(v), "bafytestcid");
    }

    /// Two fields, not one, so a project can pay for a dedicated IPFS gateway and leave Arweave on
    /// the public one. The superseded `display.gateway` param was a single prefix for both.
    function test_GatewayPreferenceIsPerScheme() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, ARWEAVE, bytes("txidtxidtxid"));
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](1);
        cf[0] = _field(GATEWAY_IPFS, INLINE, bytes("https://dedicated.mypinata.cloud/ipfs/"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_paramsC(address(renderer), f, cf)));

        _assertContains(_decodeJson(nft.tokenURI(0)), '"image":"https://arweave.net/txidtxidtxid"');
    }

    /// A gateway prefix is a short UTF-8 string; only `inline` counts. Anything else reads as
    /// "no preference stated" rather than as a second way to express one, so this rule is
    /// identical on the renderer, the generator and the off-chain resolver.
    function test_NonInlineGatewayFieldIsIgnored() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, IPFS, bytes("bafytestcid"));
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](1);
        cf[0] = _field(GATEWAY_IPFS, URL, bytes("https://wrong.example/ipfs/"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_paramsC(address(renderer), f, cf)));

        _assertContains(_decodeJson(nft.tokenURI(0)), '"image":"https://ipfs.io/ipfs/bafytestcid"');
    }

    /// One collection-scope `ipfs` field addresses a whole pinned directory — the O(1) series
    /// pattern, now available to the representation that is its own integrity anchor.
    function test_IpfsFieldSubstitutesTokenId() public {
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](1);
        cf[0] = _field(IMAGE, IPFS, bytes("bafydircid/{id}.png"));
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_paramsC(address(renderer), new IAbxOnChainMetadata.FieldInput[](0), cf))
        );

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"https://ipfs.io/ipfs/bafydircid/0.png"');
        _assertContains(json, "[collection]");
    }

    /// A value that already names its own host is emitted verbatim. Without this, an `arweave`
    /// field holding `https://arweave.net/<txid>` — which is exactly what a `backend.locator()`
    /// return looks like — comes out as `https://arweave.net/https://arweave.net/<txid>`.
    function test_AbsoluteValueIsNeverDoublePrefixed() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, ARWEAVE, bytes("https://arweave.net/txidtxidtxid"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"image":"https://arweave.net/txidtxidtxid"');
        assertFalse(
            LibString.contains(json, "arweave.net/https://"), "must not re-prefix an absolute value"
        );
    }

    /// A locator that locates nothing must not become a bare gateway prefix that 404s.
    function test_SchemeOnlyValueFallsBack() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, IPFS, bytes("ipfs://"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, "image/svg+xml"); // the deterministic placeholder
        assertFalse(LibString.contains(json, '"image":"https://ipfs.io/ipfs/"'), "no bare prefix");
    }

    function test_OptionalIpfsTextFieldWrapsAndSchemeOnlyOmits() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(ANIMATION_URL, IPFS, bytes("bafyanimcid/index.html"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));
        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(json, '"animation_url":"https://ipfs.io/ipfs/bafyanimcid/index.html"');
        _assertContains(json, '"field":"animation_url","source":"ipfs"');

        IAbxOnChainMetadata.FieldInput[] memory g = new IAbxOnChainMetadata.FieldInput[](1);
        g[0] = _field(ANIMATION_URL, ARWEAVE, bytes("ar://"));
        OneOfOneImage nft2 = OneOfOneImage(factory.deploy(_params(address(renderer), g)));
        string memory json2 = _decodeJson(nft2.tokenURI(0));
        assertFalse(LibString.contains(json2, '"animation_url":'), "omitted, not a bare prefix");
        _assertContains(json2, '"field":"animation_url","source":"omitted"');
    }

    /// The collection surface has no tokenId, so `{id}` is left alone there — the same reason
    /// `url-template` is omitted on `contractURI`.
    function test_ContractUriWrapsIpfsWithoutTemplating() public {
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](2);
        cf[0] = _field(BANNER_IMAGE, IPFS, bytes("bafybannercid"));
        cf[1] = _field(FEATURED_IMAGE, IPFS, bytes("bafyfeaturedcid/{id}.png"));
        OneOfOneImage nft = OneOfOneImage(
            factory.deploy(_paramsC(address(renderer), new IAbxOnChainMetadata.FieldInput[](0), cf))
        );

        string memory json = _decodeJson(nft.contractURI());
        _assertContains(json, '"banner_image":"https://ipfs.io/ipfs/bafybannercid"');
        _assertContains(json, '"featured_image":"https://ipfs.io/ipfs/bafyfeaturedcid/{id}.png"');
        _assertContains(json, '"field":"banner_image","source":"ipfs"');
    }

    /// The gateway keys are a SERVING PREFERENCE, not metadata. Neither document may carry them.
    function test_GatewayFieldsNeverAppearInEitherDocument() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, IPFS, bytes("bafytestcid"));
        IAbxOnChainMetadata.FieldInput[] memory cf = new IAbxOnChainMetadata.FieldInput[](2);
        cf[0] = _field(GATEWAY_IPFS, INLINE, bytes("https://dedicated.mypinata.cloud/ipfs/"));
        cf[1] = _field(GATEWAY_ARWEAVE, INLINE, bytes("https://ar.example/"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_paramsC(address(renderer), f, cf)));

        string memory tokenJson = _decodeJson(nft.tokenURI(0));
        string memory collJson = _decodeJson(nft.contractURI());
        assertFalse(LibString.contains(tokenJson, "abx_gateway"), "not a token key");
        assertFalse(LibString.contains(collJson, "abx_gateway"), "not a collection key");
        // the prefix is present only where it belongs: inside the projected image URL
        _assertContains(tokenJson, '"image":"https://dedicated.mypinata.cloud/ipfs/bafytestcid"');
    }

    /// Provenance stays honest: the LOCATOR is on chain, the BYTES are not, and a contract cannot
    /// re-hash what a gateway serves — so this says "served through", never "verified".
    function test_IpfsProvenanceDoesNotClaimVerification() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = _field(IMAGE, IPFS, bytes("bafytestcid"));
        OneOfOneImage nft = OneOfOneImage(factory.deploy(_params(address(renderer), f)));

        string memory json = _decodeJson(nft.tokenURI(0));
        _assertContains(
            json,
            '"source":"ipfs","note":"stored on chain; a content-addressed locator, served through the collection\'s preferred gateway"'
        );
        assertFalse(LibString.contains(json, "verified"), "no verification claim");
    }

}

/// @dev Minimal `IAbxFieldRenderer` returning a fixed (contentType, bytes) — enough to exercise
///      the metadata renderer's `renderer`-representation dispatch + artifact emission.
contract FixedFieldRenderer {
    string private ct;
    bytes private data;

    constructor(string memory contentType_, bytes memory data_) {
        ct = contentType_;
        data = data_;
    }

    function render(address, uint256, bytes32) external view returns (string memory, bytes memory) {
        return (ct, data);
    }
}

/// @dev Deterministic seed source for the real-token (`SeriesCode`) params fixture.
contract FixedSeedSource {
    function seed(uint256 tokenId, address) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("abx", tokenId));
    }
}

/// @dev Minimal `IAbxOnChainReader` returning fixed bytes — enough to exercise the `reader`
///      representation's dispatch.
contract FixedReader {
    bytes private data;

    constructor(bytes memory data_) {
        data = data_;
    }

    function read(address) external view returns (bytes memory) {
        return data;
    }
}

/// @dev A hand-built token surface — the metadata fields the renderer reads plus the Params /
///      Configurable Params read surfaces — so the v4 tests can craft states no honest token
///      reaches: keys listed but unset, reserved coordinates in a key list, reverting or
///      malformed getters. Unlike the real store this lists EVERY key it is handed (including
