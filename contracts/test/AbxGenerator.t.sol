// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {AbxGenerator} from "../src/renderers/AbxGenerator.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {IAbxFieldRenderer} from "../src/uri/IAbxFieldRenderer.sol";
import {IAbxDependencies} from "../src/extensions/dependencies/IAbxDependencies.sol";
import {IAbxAugmentHook} from "../src/extensions/configurable-params/IAbxParamHooks.sol";
import {IAbxConfigurableParams} from
    "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {DynamicBuffer} from "../src/libraries/DynamicBuffer.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Deterministic seed source so tokenData bytes are assertable.
contract StaticSeedSource is IAbxSeedSource {
    function seed(uint256 tokenId, address) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("static", tokenId));
    }
}

/// @dev Augment hook with a configurable single entry — the read-lane injection.
contract OneEntryAugmentHook is IAbxAugmentHook {
    bytes32 public key;
    string public value;

    constructor(bytes32 key_, string memory value_) {
        key = key_;
        value = value_;
    }

    function augmentTokenParams(address, uint256)
        external
        view
        returns (AugmentedParam[] memory entries)
    {
        entries = new AugmentedParam[](1);
        entries[0] = AugmentedParam({key: key, value: value});
    }
}

/// @dev A field renderer returning a LOCATOR (text/uri-list) for external_url and ordinary
///      HTML for animation_url — the metadata renderer must land the first verbatim and
///      data-wrap the second.
contract MixedFieldRenderer is IAbxFieldRenderer {
    function render(address, uint256, bytes32 field)
        external
        pure
        returns (string memory contentType, bytes memory data)
    {
        if (field == "external_url") {
            return ("text/uri-list", bytes("https://example.com/x?a=1"));
        }
        if (field == "animation_url") return ("text/html", bytes("<h1>doc</h1>"));
        revert("unknown field");
    }
}

/// @dev An IDependencyRegistryV0-shaped mock: the two reads the generator speaks, with a
///      kill switch for never-revert coverage.
contract MockDependencyRegistry {
    struct Entry {
        bool exists;
        bool availableOnChain;
        string preferredCDN;
        string[] chunks;
    }

    mapping(bytes32 => Entry) internal entries;
    bool public revertAll;

    function setRevertAll(bool v) external {
        revertAll = v;
    }

    function setCdn(bytes32 ref, string calldata cdn) external {
        entries[ref].exists = true;
        entries[ref].preferredCDN = cdn;
    }

    function setOnChain(bytes32 ref, string[] calldata chunks) external {
        Entry storage e = entries[ref];
        e.exists = true;
        e.availableOnChain = true;
        delete e.chunks;
        for (uint256 i; i < chunks.length; ++i) {
            e.chunks.push(chunks[i]);
        }
    }

    function getDependencyDetails(bytes32 ref)
        external
        view
        returns (
            string memory nameAndVersion,
            string memory licenseType,
            string memory preferredCDN,
            uint24 additionalCDNCount,
            string memory preferredRepository,
            uint24 additionalRepositoryCount,
            string memory dependencyWebsite,
            bool availableOnChain,
            uint24 scriptCount
        )
    {
        require(!revertAll, "registry dead");
        Entry storage e = entries[ref];
        return (
            e.exists ? "x" : "",
            "",
            e.preferredCDN,
            0,
            "",
            0,
            "",
            e.availableOnChain,
            uint24(e.chunks.length)
        );
    }

    function getDependencyScript(bytes32 ref, uint256 index)
        external
        view
        returns (string memory)
    {
        require(!revertAll, "registry dead");
        return entries[ref].chunks[index];
    }
}

/// @dev A code token predating on-chain param enumeration: every read the generator makes
///      UNGUARDED still answers, but `contractParamKeys` / `tokenParamKeys` are absent
///      selectors — the degradation case {AbxGenerator.paramKeysOf} guards.
contract LegacyParamsCodeToken {
    struct Param {
        bytes32 value;
        bool isSet;
    }

    mapping(bytes32 => Param) internal contractParams;
    mapping(uint256 => mapping(bytes32 => Param)) internal tokenParams;
    address public augmentHook;

    function setContractParamValue(bytes32 key, bytes32 value) external {
        contractParams[key] = Param({value: value, isSet: true});
    }

    function setTokenParamValue(uint256 tokenId, bytes32 key, bytes32 value) external {
        tokenParams[tokenId][key] = Param({value: value, isSet: true});
    }

    function setAugmentHook(address hook) external {
        augmentHook = hook;
    }

    function contractParam(bytes32 key) external view returns (bytes32, bool, bool) {
        Param storage p = contractParams[key];
        return (p.value, false, p.isSet);
    }

    function tokenParam(uint256 tokenId, bytes32 key) external view returns (bytes32, bool, bool) {
        Param storage p = tokenParams[tokenId][key];
        return (p.value, false, p.isSet);
    }

    function contractParamData(bytes32) external pure returns (bytes memory) {
        return "";
    }

    function tokenParamData(uint256, bytes32) external pure returns (bytes memory) {
        return "";
    }

    function paramHooks() external view returns (address, address, address) {
        return (address(0), augmentHook, address(0));
    }

    function scriptChunkCount() external pure returns (uint256) {
        return 1;
    }

    function scriptChunk(uint256) external pure returns (bytes memory) {
        return bytes("draw();");
    }

    function dependencyCount() external pure returns (uint256) {
        return 0;
    }
}

/// @dev The same token with HOSTILE key getters — the enumeration surface answers, but with
///      reserved coordinate names and unprintable `bytes32` the generator must survive.
contract HostileParamKeysCodeToken is LegacyParamsCodeToken {
    bytes32[] internal cKeys;
    bytes32[] internal tKeys;

    function setKeys(bytes32[] calldata contractKeys, bytes32[] calldata tokenKeys) external {
        cKeys = contractKeys;
        tKeys = tokenKeys;
    }

    function contractParamKeys() external view returns (bytes32[] memory) {
        return cKeys;
    }

    function tokenParamKeys(uint256) external view returns (bytes32[] memory) {
        return tKeys;
    }
}

/// @notice {AbxGenerator}, the canonical on-chain generator: template-branch document
///         byte-shape vs the resolver reference, directory-branch URL emission (base64url +
///         collection gateway-field override), branch precedence, enumeration-driven canonical
///         tokenData (both scopes, token-wins, sorted byte forms, and the degradation when a
///         token has no — or a lying — key-enumeration surface), never-revert degradation,
///         {onChainStatus} honesty, piecewise-getter consistency, the {AbxMetadataRenderer}
///         end-to-end lane, and one gas-documentation run at ~100KB dependency scale.
contract AbxGeneratorTest is Test {
    bytes32 internal constant RENDERER_REP = "renderer";
    bytes32 internal constant DEP_P5 = "p5js@1.0.0";
    bytes32 internal constant DEP_THREE = "three@0.124.0";
    bytes32 internal constant DEP_UNKNOWN = "nope@9.9.9";

    string internal constant IPFS_GATEWAY = "https://ipfs.io/ipfs/";
    string internal constant ARWEAVE_GATEWAY = "https://arweave.net/";

    SeriesCodeFactory internal factory;
    AbxMetadataRenderer internal metadataRenderer;
    MockDependencyRegistry internal defaultRegistry;
    MockDependencyRegistry internal collectionRegistry;
    AbxGenerator internal gen;
    StaticSeedSource internal seedSource;

    string internal abxJsSource;
    string internal gunzipSource;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");

    function setUp() public {
        factory = new SeriesCodeFactory();
        metadataRenderer = new AbxMetadataRenderer();
        defaultRegistry = new MockDependencyRegistry();
        collectionRegistry = new MockDependencyRegistry();
        seedSource = new StaticSeedSource();

        abxJsSource = vm.readFile("assets/abx.js");
        gunzipSource = vm.readFile("assets/gunzipScripts-0.0.1.js");
        gen = new AbxGenerator(
            address(defaultRegistry),
            SSTORE2.write(bytes(abxJsSource)),
            SSTORE2.write(bytes(gunzipSource)),
            IPFS_GATEWAY,
            ARWEAVE_GATEWAY
        );
    }

    // ── setup helpers ────────────────────────────────────────────────────────

    /// @dev A SeriesCode with the generator wired as the collection-scope `animation_url`
    ///      field renderer (the worked-combo shape), plus optional extra collection fields.
    function _deploy(IAbxOnChainMetadata.FieldInput[] memory extraFields)
        internal
        returns (SeriesCode nft)
    {
        IAbxOnChainMetadata.FieldInput[] memory contractFields =
            new IAbxOnChainMetadata.FieldInput[](1 + extraFields.length);
        contractFields[0] =
            IAbxOnChainMetadata.FieldInput("animation_url", RENDERER_REP, abi.encode(address(gen)));
        for (uint256 i; i < extraFields.length; ++i) {
            contractFields[1 + i] = extraFields[i];
        }

        nft = SeriesCode(
            factory.deploy(
                SeriesCode.InitParams({
                    owner: owner,
                    name: "Gen",
                    symbol: "GEN",
                    tokenURIBase: "",
                    tokenURIRenderer: address(metadataRenderer),
                    contractURIBase: "",
                    contractURIRenderer: address(metadataRenderer),
                    royaltyReceiver: owner,
                    royaltyBps: 500,
                    maxRoyaltyBps: 1000,
                    burnable: false,
                    transferValidator: address(0),
                    maxInvocations: 3,
                    primaryPayee: address(0),
                    minter: address(0),
                    paused: false,
                    seedSource: address(seedSource),
                    disableTokenOwnerDelegation: false,
                    mintTo: address(0),
                    mintCount: 0,
                    tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
                    contractFields: contractFields
                })
            )
        );
        vm.prank(owner);
        nft.mint(collector);
    }

    function _deployTemplate() internal returns (SeriesCode nft) {
        nft = _deploy(new IAbxOnChainMetadata.FieldInput[](0));
        vm.startPrank(owner);
        nft.setScriptChunk(0, bytes("let s=abx.tokenData.seed;"));
        nft.setScriptChunk(1, bytes("draw(s);"));
        nft.setDependencyRegistry(address(collectionRegistry));
        vm.stopPrank();
    }

    function _deployDirectory(bytes32 representation, bytes memory locator)
        internal
        returns (SeriesCode nft)
    {
        IAbxOnChainMetadata.FieldInput[] memory extra = new IAbxOnChainMetadata.FieldInput[](1);
        extra[0] = IAbxOnChainMetadata.FieldInput("code", representation, locator);
        nft = _deploy(extra);
    }

    /// @dev The canonical coordinate fragments — ALWAYS fully sorted now that the generator
    ///      enumerates, so `seed` precedes `tokenId` (the SDK serializer's shape).
    function _coordsSorted(SeriesCode nft, uint256 tokenId)
        internal
        pure
        returns (string memory beforeSeed, string memory seedAndTokenId)
    {
        bytes32 expectedSeed = keccak256(abi.encodePacked("static", tokenId));
        beforeSeed = string.concat(
            '"chainId":31337,"contractAddress":"', LibString.toHexString(address(nft)), '"'
        );
        seedAndTokenId = string.concat(
            '"seed":"',
            LibString.toHexString(uint256(expectedSeed), 32),
            '","tokenId":"',
            LibString.toString(tokenId),
            '"'
        );
    }

    /// @dev The coordinates-only canonical object: what a project with no params emits.
    function _expectedTokenDataJson(SeriesCode nft, uint256 tokenId)
        internal
        pure
        returns (string memory)
    {
        (string memory beforeSeed, string memory seedAndTokenId) = _coordsSorted(nft, tokenId);
        return string.concat("{", beforeSeed, ",", seedAndTokenId, "}");
    }

    function _json(string memory uri) internal pure returns (string memory) {
        string memory prefix = "data:application/json;base64,";
        return string(Base64.decode(LibString.slice(uri, bytes(prefix).length, bytes(uri).length)));
    }

    function _fromDataUri(string memory uri, string memory prefix)
        internal
        pure
        returns (string memory)
    {
        return string(Base64.decode(LibString.slice(uri, bytes(prefix).length, bytes(uri).length)));
    }

    // ── template branch: document byte-shape ────────────────────────────────--

    /// @dev Zero deps, two chunks — the FULL document must byte-match the resolver's
    ///      reference shape (assembleGeneratorDocument's join).
    function test_TemplateDocumentByteShape() public {
        SeriesCode nft = _deployTemplate();
        string memory expected = string.concat(
            "<!doctype html>\n",
            '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n',
            "<style>html,body{margin:0;padding:0;overflow:hidden}canvas{display:block}</style>\n",
            "<script>window.abxTokenData=",
            _expectedTokenDataJson(nft, 0),
            ";</script>\n",
            "<script>",
            abxJsSource,
            "</script>\n",
            "</head><body>\n<script>\n",
            "let s=abx.tokenData.seed;\ndraw(s);",
            "\n</script>\n</body></html>"
        );
        assertEq(gen.document(address(nft), 0), expected, "reference document shape");
    }

    function test_TemplateGzipDepRidesVerbatimWithBootstrapOnce() public {
        SeriesCode nft = _deployTemplate();
        string[] memory chunks = new string[](2);
        chunks[0] = "H4sIAAAAAAAA";
        chunks[1] = "A2NgYGBgAAA="; // pre-gzip'd+base64'd text rides VERBATIM — never transcoded
        collectionRegistry.setOnChain(DEP_P5, chunks);
        collectionRegistry.setCdn(DEP_THREE, "https://cdn.example/three.min.js");
        vm.startPrank(owner);
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, DEP_P5);
        nft.setDependency(1, IAbxDependencies.Resolution.Registry, DEP_THREE);
        nft.setDependency(2, IAbxDependencies.Resolution.Registry, DEP_UNKNOWN);
        vm.stopPrank();

        string memory doc = gen.document(address(nft), 0);

        // the inert gzip tag: chunks concatenated verbatim inside the data URI
        string memory gzipTag =
            '<script type="text/javascript+gzip" src="data:text/javascript;base64,H4sIAAAAAAAAA2NgYGBgAAA="></script>';
        assertTrue(LibString.contains(doc, gzipTag), "gzip dep tag verbatim");

        // the gunzip bootstrap tag, exactly once, base64 of the baked source
        string memory bootstrapTag = string.concat(
            '<script src="data:text/javascript;base64,',
            Base64.encode(bytes(gunzipSource)),
            '"></script>'
        );
        assertTrue(LibString.contains(doc, bootstrapTag), "bootstrap tag present");
        assertEq(
            _countOccurrences(doc, '<script src="data:text/javascript;base64,'),
            1,
            "bootstrap rides once"
        );

        // bootstrap sits AFTER the last gzip tag and BEFORE the CDN tag (dep order kept)
        string memory cdnTag = '<script src="https://cdn.example/three.min.js"></script>';
        assertTrue(LibString.contains(doc, cdnTag), "cdn dep tag");
        uint256 gzipAt = LibString.indexOf(doc, gzipTag);
        uint256 bootstrapAt = LibString.indexOf(doc, bootstrapTag);
        uint256 cdnAt = LibString.indexOf(doc, cdnTag);
        assertTrue(gzipAt < bootstrapAt && bootstrapAt < cdnAt, "gzip < bootstrap < cdn");

        // the unknown ref degrades to the comment marker — never a revert
        assertTrue(
            LibString.contains(doc, "<!-- abx:unresolved nope@9.9.9 -->"), "unresolved marker"
        );

        // tokenData + abx.js + script chunks all present
        assertTrue(
            LibString.contains(
                doc, string.concat("<script>window.abxTokenData=", _expectedTokenDataJson(nft, 0))
            ),
            "tokenData injected"
        );
        assertTrue(LibString.contains(doc, "window.abx = window.abx || {}"), "abx.js inlined");
        assertTrue(
            LibString.contains(doc, "let s=abx.tokenData.seed;\ndraw(s);"), "script chunks joined"
        );
    }

    function test_TemplateNoGzipDepsMeansNoBootstrap() public {
        SeriesCode nft = _deployTemplate();
        collectionRegistry.setCdn(DEP_THREE, "https://cdn.example/three.min.js");
        vm.prank(owner);
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, DEP_THREE);

        string memory doc = gen.document(address(nft), 0);
        assertEq(
            _countOccurrences(doc, '<script src="data:text/javascript;base64,'),
            0,
            "no bootstrap without gzip tags"
        );
    }

    function test_TemplateOnChainRefInlinesFromSstore2() public {
        SeriesCode nft = _deployTemplate();
        address pointer = SSTORE2.write(bytes("var LIB=1;"));
        vm.prank(owner);
        nft.setDependency(0, IAbxDependencies.Resolution.OnChain, bytes32(bytes20(pointer)));

        string memory doc = gen.document(address(nft), 0);
        assertTrue(LibString.contains(doc, "<script>var LIB=1;</script>"), "sstore2 dep inlined");
    }

    function test_TemplateDefaultRegistryWhenCollectionUnset() public {
        SeriesCode nft = _deploy(new IAbxOnChainMetadata.FieldInput[](0));
        vm.startPrank(owner);
        nft.setScriptChunk(0, bytes("draw();"));
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, DEP_P5);
        vm.stopPrank(); // no setDependencyRegistry → the generator's default resolves

        defaultRegistry.setCdn(DEP_P5, "https://cdn.example/p5.min.js");
        string memory doc = gen.document(address(nft), 0);
        assertTrue(
            LibString.contains(doc, '<script src="https://cdn.example/p5.min.js"></script>'),
            "default registry resolved the ref"
        );
    }

    function test_TemplateScriptCloseTagEscaped() public {
        SeriesCode nft = _deploy(new IAbxOnChainMetadata.FieldInput[](0));
        vm.prank(owner);
        nft.setScriptChunk(0, bytes('x.innerHTML="</script>";'));

        string memory doc = gen.document(address(nft), 0);
        assertTrue(
            LibString.contains(doc, 'x.innerHTML="<\\/script>";'),
            "inline-script escape applied to chunk content"
        );
        // the document still ends with exactly one real closing script element in the body
        assertTrue(LibString.contains(doc, "\n</script>\n</body></html>"), "shell intact");
    }

    /// The escape matches the tag name case-insensitively, as a browser does — and as the
    /// off-chain reference generator (`/gi`) always has. A case-sensitive match here under-escaped,
    /// so `</SCRIPT>` came back escaped from the resolver and raw from this contract: the same token
    /// rendering differently depending on which surface served it, against the documented
    /// byte-parity guarantee.
    function test_TemplateScriptCloseTagEscapedAnyCase() public {
        SeriesCode nft = _deploy(new IAbxOnChainMetadata.FieldInput[](0));
        vm.prank(owner);
        nft.setScriptChunk(0, bytes('a="</SCRIPT>";b="</Script>";c="</script>";'));

        string memory doc = gen.document(address(nft), 0);
        assertTrue(LibString.contains(doc, 'a="<\\/SCRIPT>";'), "uppercase escaped");
        assertTrue(LibString.contains(doc, 'b="<\\/Script>";'), "mixed case escaped");
        assertTrue(LibString.contains(doc, 'c="<\\/script>";'), "lowercase still escaped");
        assertTrue(LibString.contains(doc, "\n</script>\n</body></html>"), "shell intact");
    }

    /// A script with no `</` at all takes the fast path and is passed through untouched.
    function test_TemplateScriptWithoutCloseTagIsUnchanged() public {
        SeriesCode nft = _deploy(new IAbxOnChainMetadata.FieldInput[](0));
        vm.prank(owner);
        nft.setScriptChunk(0, bytes("let a = 1 / 2; if (a < 3) {}"));

        assertTrue(
            LibString.contains(gen.document(address(nft), 0), "let a = 1 / 2; if (a < 3) {}"),
            "untouched when there is nothing to escape"
        );
    }

    function test_TemplateTokenDataLtEscapedAndAugmentRides() public {
        SeriesCode nft = _deployTemplate();
        OneEntryAugmentHook hook = new OneEntryAugmentHook("mood", "<dusk>");
        vm.prank(owner);
        nft.setParamHooks(address(0), address(hook), address(0));

        string memory doc = gen.document(address(nft), 0);
        assertTrue(
            LibString.contains(doc, '"mood":"\\u003cdusk>"'),
            "augment entry rides, with the inline-JSON lt escape"
        );
        // the raw piecewise JSON stays unescaped (delivery form is document-only)
        assertTrue(
            LibString.contains(gen.tokenDataJson(address(nft), 0), '"mood":"<dusk>"'),
            "tokenDataJson is the raw canonical form"
        );
    }

    // ── directory branch ────────────────────────────────────────────────────--

    function test_Base64UrlKnownVectors() public pure {
        // hardcoded vector: base64url('{"a":1}') — fileSafe, no padding
        bytes memory buf = DynamicBuffer.allocate(64);
        DynamicBuffer.appendSafeBase64(buf, bytes('{"a":1}'), true, true);
        assertEq(string(buf), "eyJhIjoxfQ", "base64url vector");

        // fileSafe alphabet flips +/ to -_ ; padding restored when asked
        buf = DynamicBuffer.allocate(64);
        DynamicBuffer.appendSafeBase64(buf, hex"fbff7e", true, true);
        assertEq(string(buf), "-_9-", "url-safe alphabet");
        buf = DynamicBuffer.allocate(64);
        DynamicBuffer.appendSafeBase64(buf, hex"fbff7e", false, false);
        assertEq(string(buf), "+/9+", "standard alphabet");
    }

    function test_DirectoryUrlEmission() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("bafytestcid"));
        string memory url = gen.document(address(nft), 0);
        string memory expected = string.concat(
            "https://ipfs.io/ipfs/bafytestcid/index.html?abx=",
            Base64.encode(bytes(gen.tokenDataJson(address(nft), 0)), true, true)
        );
        assertEq(url, expected, "parameterized locator");
        // and the payload decodes back to the exact canonical JSON
        assertEq(gen.tokenDataJson(address(nft), 0), _expectedTokenDataJson(nft, 0));
    }

    function test_DirectoryIpfsSchemePrefixStripped() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("ipfs://bafytestcid"));
        assertTrue(
            LibString.startsWith(
                gen.document(address(nft), 0), "https://ipfs.io/ipfs/bafytestcid/index.html?abx="
            ),
            "ipfs:// stripped, never double-prefixed"
        );
    }

    function test_DirectoryArweaveGateway() public {
        SeriesCode nft = _deployDirectory("arweave", bytes("TXID123"));
        assertTrue(
            LibString.startsWith(
                gen.document(address(nft), 0), "https://arweave.net/TXID123/index.html?abx="
            ),
            "arweave root rides its gateway"
        );
    }

    function test_DirectoryAbsoluteUrlRidesVerbatim() public {
        SeriesCode nft = _deployDirectory("url", bytes("https://example.com/build/"));
        assertTrue(
            LibString.startsWith(
                gen.document(address(nft), 0), "https://example.com/build/index.html?abx="
            ),
            "absolute url verbatim; trailing slash collapsed"
        );
    }

    function test_DirectoryHtmlEntryUsedAsIs() public {
        SeriesCode nft = _deployDirectory("url", bytes("https://example.com/piece.html"));
        assertTrue(
            LibString.startsWith(
                gen.document(address(nft), 0), "https://example.com/piece.html?abx="
            ),
            ".html root IS the entry"
        );
    }

    function test_DirectoryGatewayOverride() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("bafytestcid"));
        vm.prank(owner);
        nft.setContractField("abx_gateway_ipfs", "inline", bytes("https://gw.example/ipfs/"));
        assertTrue(
            LibString.startsWith(
                gen.document(address(nft), 0), "https://gw.example/ipfs/bafytestcid/index.html?abx="
            ),
            "collection gateway field overrides the generator default"
        );
    }

    /// No 32-byte ceiling to work around any more. `display.gateway` was a param, so a prefix
    /// longer than a `bytes32` literal had to take the data-backed path and the generator had to
    /// read BOTH encodings; a metadata field is `bytes` at every length, which is most of why the
    /// old `_gateway` helper was four branches and this one is one.
    function test_DirectoryGatewayOverrideLongPrefix() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("bafytestcid"));
        string memory longGateway = "https://my-very-long-dedicated-gateway.example.com/ipfs/";
        vm.prank(owner);
        nft.setContractField("abx_gateway_ipfs", "inline", bytes(longGateway));
        assertTrue(
            LibString.startsWith(
                gen.document(address(nft), 0),
                string.concat(longGateway, "bafytestcid/index.html?abx=")
            ),
            "gateway prefix longer than 32 bytes"
        );
    }

    /// The two schemes are separate fields, so a project can pay for a dedicated IPFS gateway and
    /// leave Arweave on the public one. `display.gateway` was a single prefix for both and could
    /// not express this at all.
    function test_DirectoryGatewayFieldsAreScopedPerScheme() public {
        SeriesCode nft = _deployDirectory("arweave", bytes("txidtxidtxid"));
        vm.prank(owner);
        nft.setContractField("abx_gateway_ipfs", "inline", bytes("https://gw.example/ipfs/"));
        assertTrue(
            LibString.startsWith(
                gen.document(address(nft), 0), "https://arweave.net/txidtxidtxid/index.html?abx="
            ),
            "an ipfs preference must not reach an arweave root"
        );
        vm.prank(owner);
        nft.setContractField("abx_gateway_arweave", "inline", bytes("https://ar.example/"));
        assertTrue(
            LibString.startsWith(
                gen.document(address(nft), 0), "https://ar.example/txidtxidtxid/index.html?abx="
            ),
            "arweave preference applies to the arweave root"
        );
    }

    /// The old `display.gateway` param is inert — deliberately no compatibility read, so a project
    /// carrying one is not silently served two different gateways by two different surfaces.
    function test_DirectoryDisplayGatewayParamIsIgnored() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("bafytestcid"));
        vm.prank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("display.gateway", bytes32("https://gw.example/ipfs/"));
        assertTrue(
            LibString.startsWith(
                gen.document(address(nft), 0), "https://ipfs.io/ipfs/bafytestcid/index.html?abx="
            ),
            "display.gateway no longer overrides anything"
        );
    }

    // ── branch precedence + never-revert ────────────────────────────────────--

    function test_TemplateWinsWhenBoth() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("bafytestcid"));
        vm.prank(owner);
        nft.setScriptChunk(0, bytes("draw();"));

        (uint8 branch,,,) = gen.onChainStatus(address(nft));
        assertEq(branch, gen.BRANCH_TEMPLATE(), "template wins when both");
        assertTrue(
            LibString.startsWith(gen.document(address(nft), 0), "<!doctype html>"),
            "document is the HTML, not the locator"
        );
    }

    function test_NeverRevert_RegistryDead() public {
        SeriesCode nft = _deployTemplate();
        vm.prank(owner);
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, DEP_P5);
        collectionRegistry.setRevertAll(true);

        (string memory contentType, bytes memory data) =
            gen.render(address(nft), 0, "animation_url");
        assertEq(contentType, "text/html");
        assertTrue(
            LibString.contains(string(data), "<!-- abx:unresolved p5js@1.0.0 -->"),
            "reverting registry degrades to the marker"
        );
    }

    function test_NeverRevert_EmptyProject() public {
        SeriesCode nft = _deploy(new IAbxOnChainMetadata.FieldInput[](0)); // no chunks, no code
        (string memory contentType, bytes memory data) =
            gen.render(address(nft), 0, "animation_url");
        assertEq(contentType, "text/html");
        assertEq(string(data), "<!-- abx:no-code -->");
    }

    function test_NeverRevert_UnmintedToken() public {
        SeriesCode nft = _deployTemplate();
        (, bytes memory data) = gen.render(address(nft), 999, "animation_url");
        assertTrue(LibString.contains(string(data), '"tokenId":"999"'), "coordinates still ride");
        assertFalse(LibString.contains(string(data), '"seed"'), "no seed for an unminted token");
    }

    function test_NeverRevert_NonAbxToken() public view {
        // no code at the address
        (string memory ct1, bytes memory d1) = gen.render(address(0xDEAD), 0, "animation_url");
        assertEq(ct1, "text/html");
        assertEq(string(d1), "<!-- abx:no-code -->");
        // a contract that has code but none of the ABX reads
        (string memory ct2, bytes memory d2) =
            gen.render(address(defaultRegistry), 0, "animation_url");
        assertEq(ct2, "text/html");
        assertEq(string(d2), "<!-- abx:no-code -->");
    }

    function test_NeverRevert_UnserveableCodeRepresentation() public {
        SeriesCode nft = _deployDirectory("inline", bytes("<html>not a locator</html>"));
        (string memory contentType, bytes memory data) =
            gen.render(address(nft), 0, "animation_url");
        assertEq(contentType, "text/html");
        assertEq(string(data), "<!-- abx:unresolved code -->");
    }

    function test_UnknownFieldReturnsEmpty() public {
        SeriesCode nft = _deployTemplate();
        (string memory contentType, bytes memory data) = gen.render(address(nft), 0, "image");
        assertEq(contentType, "text/plain");
        assertEq(data.length, 0);
    }

    // ── onChainStatus ───────────────────────────────────────────────────────--

    function test_OnChainStatus_None() public {
        SeriesCode nft = _deploy(new IAbxOnChainMetadata.FieldInput[](0));
        (uint8 branch, bool chainComplete, bytes32[] memory unresolved, bool overBudget) =
            gen.onChainStatus(address(nft));
        assertEq(branch, gen.BRANCH_NONE());
        assertFalse(chainComplete);
        assertEq(unresolved.length, 0);
        assertFalse(overBudget);
    }

    function test_OnChainStatus_TemplateChainComplete() public {
        SeriesCode nft = _deployTemplate();
        string[] memory chunks = new string[](1);
        chunks[0] = "H4sIAAAA";
        collectionRegistry.setOnChain(DEP_P5, chunks);
        address pointer = SSTORE2.write(bytes("var LIB=1;"));
        vm.startPrank(owner);
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, DEP_P5);
        nft.setDependency(1, IAbxDependencies.Resolution.OnChain, bytes32(bytes20(pointer)));
        vm.stopPrank();

        (uint8 branch, bool chainComplete, bytes32[] memory unresolved, bool overBudget) =
            gen.onChainStatus(address(nft));
        assertEq(branch, gen.BRANCH_TEMPLATE());
        assertTrue(chainComplete, "all deps proven on-chain");
        assertEq(unresolved.length, 0);
        assertFalse(overBudget);
    }

    function test_OnChainStatus_CdnBreaksChainCompletenessButResolves() public {
        SeriesCode nft = _deployTemplate();
        collectionRegistry.setCdn(DEP_THREE, "https://cdn.example/three.min.js");
        vm.prank(owner);
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, DEP_THREE);

        (, bool chainComplete, bytes32[] memory unresolved,) = gen.onChainStatus(address(nft));
        assertFalse(chainComplete, "CDN dep is served, but not chain-complete");
        assertEq(unresolved.length, 0, "a CDN dep is NOT unresolved");
    }

    function test_OnChainStatus_UnresolvedRefsReported() public {
        SeriesCode nft = _deployTemplate();
        string[] memory chunks = new string[](1);
        chunks[0] = "H4sIAAAA";
        collectionRegistry.setOnChain(DEP_P5, chunks);
        vm.startPrank(owner);
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, DEP_P5);
        nft.setDependency(1, IAbxDependencies.Resolution.Registry, DEP_UNKNOWN);
        vm.stopPrank();

        (, bool chainComplete, bytes32[] memory unresolved,) = gen.onChainStatus(address(nft));
        assertFalse(chainComplete);
        assertEq(unresolved.length, 1);
        assertEq(unresolved[0], DEP_UNKNOWN);
    }

    function test_OnChainStatus_DirectoryWithinBudget() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("bafytestcid"));
        (uint8 branch, bool chainComplete,, bool overBudget) = gen.onChainStatus(address(nft));
        assertEq(branch, gen.BRANCH_DIRECTORY());
        assertFalse(chainComplete, "directory is no-server, never chain-complete");
        assertFalse(overBudget);
    }

    function test_OnChainStatus_DirectoryUrlOverBudget() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("bafytestcid"));
        // a synthetic huge param via the augment hook — the on-chain param surface a
        // directory project would push through the URL lane
        bytes memory big = new bytes(9000);
        for (uint256 i; i < big.length; ++i) {
            big[i] = "a";
        }
        OneEntryAugmentHook hook = new OneEntryAugmentHook("blob", string(big));
        vm.prank(owner);
        nft.setParamHooks(address(0), address(hook), address(0));

        (,,, bool overBudget) = gen.onChainStatus(address(nft));
        assertTrue(overBudget, "emitted URL exceeds the 8KB budget");
        assertTrue(
            bytes(gen.document(address(nft), 0)).length > gen.URL_BUDGET_BYTES(),
            "the URL itself is still emitted IN FULL - params are never silently dropped"
        );
    }

    // ── piecewise getters ───────────────────────────────────────────────────--

    function test_PiecewiseGettersConsistentWithDocument() public {
        SeriesCode nft = _deployTemplate();
        string[] memory chunks = new string[](2);
        chunks[0] = "H4sIAAAAAAAA";
        chunks[1] = "A2NgYGBgAAA=";
        collectionRegistry.setOnChain(DEP_P5, chunks);
        collectionRegistry.setCdn(DEP_THREE, "https://cdn.example/three.min.js");
        vm.startPrank(owner);
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, DEP_P5);
        nft.setDependency(1, IAbxDependencies.Resolution.Registry, DEP_THREE);
        vm.stopPrank();

        string memory doc = gen.document(address(nft), 0);
        assertTrue(
            LibString.contains(doc, gen.dependencyTag(address(nft), 0)), "dep tag 0 in document"
        );
        assertTrue(
            LibString.contains(doc, gen.dependencyTag(address(nft), 1)), "dep tag 1 in document"
        );
        assertTrue(
            LibString.contains(doc, gen.tokenDataJson(address(nft), 0)),
            "tokenDataJson in document (no lt chars in this payload)"
        );
        assertTrue(LibString.contains(doc, gen.abxJs()), "abxJs in document");
        assertTrue(
            LibString.contains(doc, Base64.encode(bytes(gen.gunzipScript()))),
            "gunzip bootstrap (b64) in document"
        );
        assertEq(
            gen.registryScriptChunk(address(collectionRegistry), DEP_P5, 1),
            "A2NgYGBgAAA=",
            "registry chunk piecewise read"
        );
        (bytes32 rep, bytes memory value) = gen.codeLocator(address(nft));
        assertEq(rep, bytes32(0));
        assertEq(value.length, 0);
    }

    // ── end to end through the canonical metadata renderer ──────────────────--

    function test_EndToEnd_TemplateTokenUriInjectsTokenData() public {
        SeriesCode nft = _deployTemplate();
        string memory json = _json(nft.tokenURI(0));
        string memory animation = vm.parseJsonString(json, ".animation_url");
        assertTrue(
            LibString.startsWith(animation, "data:text/html;base64,"), "data-URI wrapped html"
        );
        string memory html = _fromDataUri(animation, "data:text/html;base64,");
        assertTrue(LibString.contains(html, '"chainId":31337'), "coordinates injected");
        assertTrue(
            LibString.contains(
                html,
                string.concat('"contractAddress":"', LibString.toHexString(address(nft)), '"')
            ),
            "address injected"
        );
        assertTrue(LibString.contains(html, '"tokenId":"0"'), "tokenId injected");
        assertTrue(LibString.contains(html, '"seed":"0x'), "seed injected");
        assertTrue(LibString.contains(html, "window.abx = window.abx || {}"), "abx.js rides");
        assertTrue(
            LibString.contains(html, "let s=abx.tokenData.seed;\ndraw(s);"), "script chunks ride"
        );
    }

    function test_EndToEnd_DirectoryTokenUriCarriesLocatorVerbatim() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("bafytestcid"));
        string memory json = _json(nft.tokenURI(0));
        string memory animation = vm.parseJsonString(json, ".animation_url");
        // text/uri-list renderer output lands VERBATIM (never data-wrapped): animation_url
        // IS the parameterized locator, dereferenceable by any marketplace.
        assertEq(animation, gen.document(address(nft), 0), "animation_url == the raw URL");
        assertTrue(
            LibString.startsWith(animation, "https://ipfs.io/ipfs/bafytestcid/index.html?abx="),
            "the locator shape, not a data: URI"
        );
    }

    function test_EndToEnd_UriListVerbatimForOtherTextFields_OthersStillWrap() public {
        MixedFieldRenderer mixed = new MixedFieldRenderer();
        IAbxOnChainMetadata.FieldInput[] memory extra = new IAbxOnChainMetadata.FieldInput[](1);
        extra[0] = IAbxOnChainMetadata.FieldInput("external_url", RENDERER_REP, abi.encode(mixed));
        SeriesCode nft = _deploy(extra);
        // repoint animation_url at the mixed renderer too (text/html output)
        vm.prank(owner);
        nft.setContractField("animation_url", RENDERER_REP, abi.encode(mixed));

        string memory json = _json(nft.tokenURI(0));
        // text/uri-list on a NON-animation text field also lands verbatim (coherent rule)
        assertEq(
            vm.parseJsonString(json, ".external_url"),
            "https://example.com/x?a=1",
            "external_url locator verbatim"
        );
        // any other contentType keeps the existing behavior: animation_url data-wraps
        string memory animation = vm.parseJsonString(json, ".animation_url");
        assertTrue(
            LibString.startsWith(animation, "data:text/html;base64,"),
            "non-uri-list animation_url still data-wraps"
        );
        assertEq(_fromDataUri(animation, "data:text/html;base64,"), "<h1>doc</h1>");
    }

    // ── tokenData params (on-chain enumeration) ─────────────────────────────--

    function test_Enumerated_SchemaHexColorCanonicalByteExact() public {
        SeriesCode nft = _deployTemplate();
        vm.startPrank(owner);
        nft.setParamSchema(
            "palette",
            IAbxConfigurableParams.ParamType.HexColor,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            0,
            bytes32(0),
            bytes32(uint256(0xFFFFFF)),
            new string[](0)
        );
        nft.configureTokenParam(0, "palette", bytes32(uint256(0x0E1A40)));
        vm.stopPrank();

        (string memory beforeSeed, string memory seedAndTokenId) = _coordsSorted(nft, 0);
        assertEq(
            gen.tokenDataJson(address(nft), 0),
            string.concat("{", beforeSeed, ',"palette":"#0e1a40",', seedAndTokenId, "}"),
            "canonical form: the enumerated key, sorted, HexColor decoded"
        );
        // and it rides the document
        assertTrue(
            LibString.contains(gen.document(address(nft), 0), '"palette":"#0e1a40"'),
            "decoded param injected"
        );
    }

    function test_Enumerated_TokenScopeWinsAndEmitsOnce() public {
        SeriesCode nft = _deployTemplate();
        vm.startPrank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("mode", bytes32("dark"));
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setTokenParam(0, "mode", bytes32("lite"));
        vm.stopPrank();

        string memory json = gen.tokenDataJson(address(nft), 0);
        assertTrue(LibString.contains(json, '"mode":"lite"'), "token scope wins");
        assertEq(_countOccurrences(json, '"mode":'), 1, "listed at both scopes, emitted once");
        // another token still sees the collection value
        vm.prank(owner);
        nft.mint(collector);
        assertTrue(
            LibString.contains(gen.tokenDataJson(address(nft), 1), '"mode":"dark"'),
            "contract scope backfills"
        );
    }

    function test_Enumerated_SchemalessRawFormsByteExact() public {
        SeriesCode nft = _deployTemplate();
        vm.startPrank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("mode", bytes32("dark")); // printable-ASCII literal → text
        nft.setContractParam("rawval", bytes32(uint256(0x1234))); // non-ASCII → full hex
        nft.setContractParamData("blob", bytes("hello")); // schema-less blob → base64
        vm.stopPrank();

        (string memory beforeSeed, string memory seedAndTokenId) = _coordsSorted(nft, 0);
        assertEq(
            gen.tokenDataJson(address(nft), 0),
            string.concat(
                '{"blob":"aGVsbG8=",',
                beforeSeed,
                ',"mode":"dark","rawval":"0x0000000000000000000000000000000000000000000000000000000000001234",',
                seedAndTokenId,
                "}"
            ),
            "SDK schema-less rules: loose-ASCII text, full bytes32 hex, base64 blob; sorted"
        );
    }

    function test_Enumerated_NoParamsIsCoordinatesPlusSeedByteExact() public {
        SeriesCode nft = _deployTemplate(); // nothing set beyond the mint-time seed
        assertEq(
            gen.tokenDataJson(address(nft), 0),
            _expectedTokenDataJson(nft, 0),
            "no params: the canonical coordinates + seed, sorted, nothing else"
        );

        // the augment hook still appends, last (augment-wins), after the sorted set
        OneEntryAugmentHook hook = new OneEntryAugmentHook("mood", "dusk");
        vm.prank(owner);
        nft.setParamHooks(address(0), address(hook), address(0));
        (string memory beforeSeed, string memory seedAndTokenId) = _coordsSorted(nft, 0);
        assertEq(
            gen.tokenDataJson(address(nft), 0),
            string.concat("{", beforeSeed, ",", seedAndTokenId, ',"mood":"dusk"}'),
            "augment entries append after the sorted set"
        );
    }

    function test_Enumerated_ClearedKeyLeavesTokenData() public {
        SeriesCode nft = _deployTemplate();
        vm.prank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("ghost", bytes32("boo"));
        assertTrue(
            LibString.contains(gen.tokenDataJson(address(nft), 0), '"ghost":"boo"'),
            "a set key is enumerated"
        );

        vm.prank(owner);
        nft.clearContractParam("ghost");
        assertEq(
            gen.tokenDataJson(address(nft), 0),
            _expectedTokenDataJson(nft, 0),
            "a cleared key leaves the enumeration, and the tokenData with it"
        );
    }

    function test_Enumerated_ReservedCoordinateKeysSkipped() public {
        SeriesCode nft = _deployTemplate();
        vm.startPrank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("mode", bytes32("dark"));
        // reserved coordinate NAMES are settable params (only `seed` is unlistable) — the
        // generator skips them defensively so the coordinates can never be overridden
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("chainId", bytes32("nope"));
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("contractAddress", bytes32("nope"));
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setTokenParam(0, "tokenId", bytes32("nope"));
        vm.stopPrank();

        string memory json = gen.tokenDataJson(address(nft), 0);
        assertTrue(LibString.contains(json, '"mode":"dark"'), "the real key rides");
        assertFalse(LibString.contains(json, '"nope"'), "no coordinate was overridden");
        assertEq(_countOccurrences(json, '"chainId":'), 1, "coordinates win: chainId once");
        assertEq(_countOccurrences(json, '"tokenId":'), 1, "coordinates win: tokenId once");
        assertEq(_countOccurrences(json, '"contractAddress":'), 1, "coordinates win: address once");
    }

    function test_Enumerated_CanonicalOrderingStraddlesSeed() public {
        SeriesCode nft = _deployTemplate();
        vm.startPrank(owner);
        // written out of order on purpose: enumeration order is insertion order, and the
        // canonical serialization sorts regardless of scope
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("size", bytes32("s2")); // "seed" < "size" < "tokenId"
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("zz", bytes32("z")); // after "tokenId"
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setTokenParam(0, "salt", bytes32("s1")); // "salt" < "seed"; token scope
        vm.stopPrank();

        // canonical order: chainId, contractAddress, salt < seed < size < tokenId < zz
        bytes32 expectedSeed = keccak256(abi.encodePacked("static", uint256(0)));
        assertEq(
            gen.tokenDataJson(address(nft), 0),
            string.concat(
                '{"chainId":31337,"contractAddress":"',
                LibString.toHexString(address(nft)),
                '","salt":"s1","seed":"',
                LibString.toHexString(uint256(expectedSeed), 32),
                '","size":"s2","tokenId":"0","zz":"z"}'
            ),
            "all keys sorted lexicographically across scopes, straddling seed and tokenId"
        );
    }

    function test_Enumerated_StringSelectAndBytesSchemasDecode() public {
        SeriesCode nft = _deployTemplate();
        string[] memory options = new string[](2);
        options[0] = "circle";
        options[1] = "square";
        vm.startPrank(owner);
        nft.setParamSchema(
            "title",
            IAbxConfigurableParams.ParamType.String,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        nft.setParamSchema(
            "shape",
            IAbxConfigurableParams.ParamType.Select,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            0,
            bytes32(0),
            bytes32(uint256(1)),
            options
        );
        nft.setParamSchema(
            "sprite",
            IAbxConfigurableParams.ParamType.Bytes,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        nft.configureTokenParamData(0, "title", bytes('He said "hi"'));
        nft.configureTokenParam(0, "shape", bytes32(uint256(1)));
        nft.configureTokenParamData(0, "sprite", bytes("hello"));
        vm.stopPrank();

        string memory json = gen.tokenDataJson(address(nft), 0);
        assertTrue(
            LibString.contains(json, '"title":"He said \\"hi\\""'),
            "String blob UTF-8, JSON-escaped"
        );
        assertTrue(LibString.contains(json, '"shape":"square"'), "Select decodes to the option");
        assertTrue(LibString.contains(json, '"sprite":"aGVsbG8="'), "Bytes blob base64 at read");
    }

    /// @dev `params.keys` was the retired CSV convention. On an enumerating token it is just
    ///      a param — listed, decoded, emitted like any other (exactly what the SDK already
    ///      does), so a stale tool that still writes it produces honest noise, never a
    ///      special case.
    function test_Enumerated_LegacyParamsKeysIsJustAnotherParam() public {
        SeriesCode nft = _deployTemplate();
        vm.startPrank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("palette", bytes32("warm"));
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("params.keys", bytes32("palette"));
        vm.stopPrank();

        (string memory beforeSeed, string memory seedAndTokenId) = _coordsSorted(nft, 0);
        assertEq(
            gen.tokenDataJson(address(nft), 0),
            string.concat(
                "{", beforeSeed, ',"palette":"warm","params.keys":"palette",', seedAndTokenId, "}"
            ),
            "the retired CSV key is an ordinary enumerated param, no special-casing"
        );
    }

    function test_Enumerated_DirectoryUrlCarriesEnumeratedParams() public {
        SeriesCode nft = _deployDirectory("ipfs", bytes("bafytestcid"));
        vm.startPrank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setContractParam("mode", bytes32("dark"));
        // forge-lint: disable-next-line(unsafe-typecast)
        nft.setTokenParam(0, "size", bytes32("3"));
        vm.stopPrank();

        string memory json = gen.tokenDataJson(address(nft), 0);
        assertTrue(LibString.contains(json, '"mode":"dark"'), "contract-scope param enumerated");
        assertTrue(LibString.contains(json, '"size":"3"'), "token-scope param enumerated");
        assertEq(
            gen.document(address(nft), 0),
            string.concat(
                "https://ipfs.io/ipfs/bafytestcid/index.html?abx=",
                Base64.encode(bytes(json), true, true)
            ),
            "the ?abx= payload IS the enumerated canonical tokenData"
        );
    }

    // ── degradation: no enumeration surface, or a lying one ─────────────────--

    function test_Degrade_TokenWithoutKeyGettersKeepsCoordinatesAndAugment() public {
        LegacyParamsCodeToken legacy = new LegacyParamsCodeToken();
        legacy.setContractParamValue("mode", "dark");
        legacy.setTokenParamValue(7, "seed", bytes32(uint256(0xABC)));
        legacy.setAugmentHook(address(new OneEntryAugmentHook("mood", "dusk")));

        assertEq(
            gen.tokenDataJson(address(legacy), 7),
            string.concat(
                '{"chainId":31337,"contractAddress":"',
                LibString.toHexString(address(legacy)),
                '","seed":"',
                LibString.toHexString(uint256(0xABC), 32),
                '","tokenId":"7","mood":"dusk"}'
            ),
            "no enumeration surface: coordinates + seed + augment, no params"
        );

        (string memory contentType, bytes memory data) =
            gen.render(address(legacy), 7, "animation_url");
        assertEq(contentType, "text/html", "render() never reverts on an old implementation");
        assertTrue(
            LibString.startsWith(string(data), "<!doctype html>"), "the document still assembles"
        );
        assertFalse(LibString.contains(string(data), '"mode"'), "un-enumerable param absent");
    }

    function test_Degrade_HostileKeyGettersNeverBreakTheJson() public {
        HostileParamKeysCodeToken hostile = new HostileParamKeysCodeToken();
        bytes32 quoteKey = 'a"b<c'; // a JSON-breaking name
        bytes32 rawKey = bytes32(uint256(1)); // unprintable — no readable name at all

        bytes32[] memory contractKeys = new bytes32[](4);
        contractKeys[0] = "chainId";
        contractKeys[1] = "seed";
        contractKeys[2] = quoteKey;
        contractKeys[3] = "ok";
        bytes32[] memory tokenKeys = new bytes32[](3);
        tokenKeys[0] = "contractAddress";
        tokenKeys[1] = "tokenId";
        tokenKeys[2] = rawKey;
        hostile.setKeys(contractKeys, tokenKeys);

        hostile.setContractParamValue("chainId", "nope");
        hostile.setContractParamValue("seed", "nope");
        hostile.setContractParamValue("contractAddress", "nope");
        hostile.setContractParamValue("tokenId", "nope");
        hostile.setContractParamValue(quoteKey, 'x"y<z');
        hostile.setContractParamValue("ok", "fine");
        hostile.setTokenParamValue(0, rawKey, bytes32(uint256(0xdead)));
        hostile.setTokenParamValue(0, "seed", bytes32(uint256(0x1234)));

        assertEq(
            gen.tokenDataJson(address(hostile), 0),
            string.concat(
                '{"":"',
                LibString.toHexString(uint256(0xdead), 32),
                '","a\\"b<c":"x\\"y<z","chainId":31337,"contractAddress":"',
                LibString.toHexString(address(hostile)),
                '","ok":"fine","seed":"',
                LibString.toHexString(uint256(0x1234), 32),
                '","tokenId":"0"}'
            ),
            "reserved names skipped, unprintables hex-decoded, quotes escaped, JSON intact"
        );

        // delivery form: every `<` becomes its unicode escape, key and value alike, so a
        // hostile param can never end the inline <script> element early
        (string memory contentType, bytes memory data) =
            gen.render(address(hostile), 0, "animation_url");
        assertEq(contentType, "text/html", "render() never reverts on a hostile token");
        assertTrue(
            LibString.contains(string(data), '"a\\"b\\u003cc":"x\\"y\\u003cz"'),
            "inline-JSON lt escape applied to the hostile key AND value"
        );
    }

    // ── gas documentation ───────────────────────────────────────────────────--

    /// @dev ~100KB of pre-encoded dependency text across 3 chunks — the realistic on-chain
    ///      p5-scale payload. Documents view-lane assembly cost (RPC eth_call caps are the
    ///      reason the piecewise getters exist). Measured on this suite (solc 0.8.28,
    ///      the 200-run profile, forge gasleft delta — see the console log):
    ///      document() = ~3.93M gas for a 116,511-byte document — well inside default node
    ///      eth_call caps (geth 50M); tokenURI's base64 wrap roughly doubles the memory held.
    function test_GasDocumentation_100KBDependency() public {
        SeriesCode nft = _deployTemplate();
        string[] memory chunks = new string[](3);
        chunks[0] = _repeat("A", 34_000);
        chunks[1] = _repeat("B", 34_000);
        chunks[2] = _repeat("C", 34_000);
        collectionRegistry.setOnChain(DEP_P5, chunks);
        vm.prank(owner);
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, DEP_P5);

        uint256 gasBefore = gasleft();
        string memory doc = gen.document(address(nft), 0);
        uint256 gasUsed = gasBefore - gasleft();

        assertTrue(bytes(doc).length > 100_000, "the ~100KB dep landed in the document");
        assertTrue(
            LibString.contains(doc, "data:text/javascript;base64,AAAA"), "gzip tag carries it"
        );
        console2.log("document() bytes:", bytes(doc).length);
        console2.log("document() gas (~100KB dep, 3 chunks):", gasUsed);

        (, bool chainComplete,,) = gen.onChainStatus(address(nft));
        assertTrue(chainComplete);
    }

    // ── helpers ─────────────────────────────────────────────────────────────--

    function _repeat(bytes1 ch, uint256 n) internal pure returns (string memory) {
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = ch;
        }
        return string(out);
    }

    function _countOccurrences(string memory subject, string memory needle)
        internal
        pure
        returns (uint256 count)
    {
        uint256 from;
        while (true) {
            uint256 at = LibString.indexOf(subject, needle, from);
            if (at == LibString.NOT_FOUND) break;
            ++count;
            from = at + 1;
        }
    }
}
