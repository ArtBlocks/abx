// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {IAbxFieldRenderer} from "../src/uri/IAbxFieldRenderer.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {IAbxParams} from "../src/extensions/params/IAbxParams.sol";
import {IAbxConfigurableParams} from
    "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {IAbxAugmentHook} from "../src/extensions/configurable-params/IAbxParamHooks.sol";
import {TokenDataLib} from "../src/libraries/TokenDataLib.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Deterministic seed source so image bytes are assertable.
contract StaticSeedSource is IAbxSeedSource {
    function seed(uint256 tokenId, address) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("static", tokenId));
    }
}

/// @dev Augment hook adding one derived key — the read-lane injection.
contract MoodAugmentHook is IAbxAugmentHook {
    function augmentTokenParams(address, uint256)
        external
        pure
        returns (AugmentedParam[] memory entries)
    {
        entries = new AugmentedParam[](1);
        entries[0] = AugmentedParam({key: "mood", value: "dusk"});
    }
}

/// @dev A creative field renderer using {TokenDataLib} — the shape a real project ships:
///      one contract computes the still, the trait array, the live-view document, and a
///      collection-surface field, all from chain state.
contract WavesFieldRenderer is IAbxFieldRenderer {
    bytes32 private constant SEED = "seed";
    bytes32 private constant PALETTE = "palette";

    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        if (field == "image") {
            (bytes32 seed,,) = IAbxParams(token).tokenParam(tokenId, SEED);
            return (
                "image/svg+xml",
                bytes(
                    string.concat(
                        '<svg xmlns="http://www.w3.org/2000/svg"><text>',
                        LibString.toHexString(uint256(seed), 32),
                        "</text></svg>"
                    )
                )
            );
        }
        if (field == "attributes") {
            (bytes32 palette,, bool isSet) = IAbxParams(token).contractParam(PALETTE);
            return (
                "application/json",
                bytes(
                    string.concat(
                        '[{"trait_type":"Palette","value":"',
                        isSet
                            ? TokenDataLib.decodeScalar(
                                IAbxConfigurableParams.ParamType.HexColor, palette
                            )
                            : "none",
                        '"}]'
                    )
                )
            );
        }
        if (field == "animation_url") {
            string memory td = TokenDataLib.begin(token, tokenId);
            td = TokenDataLib.scalarEntry(
                td, token, tokenId, PALETTE, IAbxConfigurableParams.ParamType.HexColor
            );
            td = TokenDataLib.augmentedEntries(td, token, tokenId);
            td = TokenDataLib.finish(td);
            return (
                "text/html",
                bytes(
                    string.concat(
                        "<html><script>window.abxTokenData=", td, ";</script></html>"
                    )
                )
            );
        }
        if (field == "description") {
            // proves the collection-surface sentinel reaches the renderer
            return (
                "text/plain",
                tokenId == type(uint256).max ? bytes("collection-computed") : bytes("token-computed")
            );
        }
        revert("unknown field");
    }
}

/// @notice The chain-complete combo, end to end: `renderer`-representation fields resolved by
///         the canonical metadata renderer — computed still, computed traits, an on-chain HTML
///         live view with injected tokenData, and the collection-surface sentinel — plus
///         {TokenDataLib}'s canonical decode.
contract FieldRendererTest is Test {
    bytes32 internal constant RENDERER_REP = "renderer";

    SeriesCodeFactory internal factory;
    AbxMetadataRenderer internal metadataRenderer;
    WavesFieldRenderer internal fieldRenderer;
    SeriesCode internal nft;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");

    function setUp() public {
        factory = new SeriesCodeFactory();
        metadataRenderer = new AbxMetadataRenderer();
        fieldRenderer = new WavesFieldRenderer();

        // two collection-scope field sets cover every token — the whole point of the combo
        IAbxOnChainMetadata.FieldInput[] memory contractFields = new IAbxOnChainMetadata.FieldInput[](4);
        bytes memory frPointer = abi.encode(address(fieldRenderer));
        contractFields[0] = IAbxOnChainMetadata.FieldInput("image", RENDERER_REP, frPointer);
        contractFields[1] = IAbxOnChainMetadata.FieldInput("attributes", RENDERER_REP, frPointer);
        contractFields[2] = IAbxOnChainMetadata.FieldInput("animation_url", RENDERER_REP, frPointer);
        contractFields[3] = IAbxOnChainMetadata.FieldInput("description", RENDERER_REP, frPointer);

        nft = SeriesCode(
            factory.deploy(
                SeriesCode.InitParams({
                    owner: owner,
                    name: "Waves",
                    symbol: "WAV",
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
                    seedSource: address(new StaticSeedSource()),
                    disableTokenOwnerDelegation: false,
                    mintTo: address(0),
                    mintCount: 0,
                    tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
                    contractFields: contractFields
                })
            )
        );

        vm.startPrank(owner);
        nft.setContractParam("palette", bytes32(uint256(0x0E1A40)));
        nft.mint(collector);
        vm.stopPrank();
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

    // ---- the combo, through tokenURI ----

    function test_ComputedImageIsSeededSvgDataUri() public view {
        string memory json = _json(nft.tokenURI(0));
        string memory image = vm.parseJsonString(json, ".image");
        string memory svg = _fromDataUri(image, "data:image/svg+xml;base64,");
        bytes32 expectedSeed = keccak256(abi.encodePacked("static", uint256(0)));
        assertTrue(
            LibString.contains(svg, LibString.toHexString(uint256(expectedSeed), 32)),
            "svg embeds the token's seed"
        );
    }

    function test_ComputedAttributesEmbedVerbatim() public view {
        string memory json = _json(nft.tokenURI(0));
        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "Palette");
        assertEq(vm.parseJsonString(json, ".attributes[0].value"), "#0e1a40");
    }

    function test_OnChainHtmlLiveViewInjectsTokenData() public view {
        string memory json = _json(nft.tokenURI(0));
        string memory animation = vm.parseJsonString(json, ".animation_url");
        string memory html = _fromDataUri(animation, "data:text/html;base64,");
        assertTrue(LibString.contains(html, '"chainId":31337'), "coordinates injected");
        assertTrue(
            LibString.contains(html, string.concat('"contractAddress":"', LibString.toHexString(address(nft)), '"')),
            "address injected"
        );
        assertTrue(LibString.contains(html, '"tokenId":"0"'), "tokenId injected");
        assertTrue(LibString.contains(html, '"seed":"0x'), "seed injected");
        assertTrue(LibString.contains(html, '"palette":"#0e1a40"'), "param canonically decoded");
    }

    function test_AugmentedEntriesRideTokenData() public {
        MoodAugmentHook hook = new MoodAugmentHook();
        vm.prank(owner);
        nft.setParamHooks(address(0), address(hook), address(0));

        string memory json = _json(nft.tokenURI(0));
        string memory html =
            _fromDataUri(vm.parseJsonString(json, ".animation_url"), "data:text/html;base64,");
        assertTrue(LibString.contains(html, '"mood":"dusk"'), "augment hook entry injected");
    }

    function test_ProvenanceNamesTheFieldRenderer() public view {
        string memory json = _json(nft.tokenURI(0));
        assertTrue(
            LibString.contains(json, '"source":"renderer"'), "abx_provenance carries renderer"
        );
        assertTrue(LibString.contains(json, "computed on chain (field renderer)"));
    }

    function test_CollectionSurfacePassesSentinel() public view {
        string memory json = _json(nft.contractURI());
        assertEq(vm.parseJsonString(json, ".description"), "collection-computed");
    }

    // ---- TokenDataLib canonical decode ----

    function test_DecodeDecimalTenPlaces() public pure {
        assertEq(TokenDataLib.decodeDecimal(10_000_000_000), "1"); // 1e10
        assertEq(TokenDataLib.decodeDecimal(15_000_000_000), "1.5");
        assertEq(TokenDataLib.decodeDecimal(10_123_400_000_000), "1012.34");
        assertEq(TokenDataLib.decodeDecimal(1), "0.0000000001"); // full precision floor
        assertEq(TokenDataLib.decodeDecimal(0), "0");
    }

    function test_DecodeScalars() public pure {
        assertEq(
            TokenDataLib.decodeScalar(
                IAbxConfigurableParams.ParamType.HexColor, bytes32(uint256(0x0E1A40))
            ),
            "#0e1a40"
        );
        // Out-of-domain HexColor masks to 24 bits (`& 0xffffff`). The governed write validates
        // `v <= 0xFFFFFF`, but the raw owner setter does not, so a value like this can be stored and
        // later governed by a HexColor schema. The SDK twin of this assertion is in
        // packages/sdk/test/code-fold.test.ts (`decodeScalarParam('HexColor', 0x1ffffffn)` → `#ffffff`)
        // — the two together pin the on-chain↔SDK byte-parity so neither plane can drift silently.
        assertEq(
            TokenDataLib.decodeScalar(
                IAbxConfigurableParams.ParamType.HexColor, bytes32(uint256(0x1FFFFFF))
            ),
            "#ffffff"
        );
        assertEq(
            TokenDataLib.decodeScalar(
                IAbxConfigurableParams.ParamType.HexColor, bytes32(uint256(0xABCDEF123456))
            ),
            "#123456"
        );
        assertEq(
            TokenDataLib.decodeScalar(IAbxConfigurableParams.ParamType.Bool, bytes32(uint256(1))),
            "true"
        );
        assertEq(
            TokenDataLib.decodeScalar(
                IAbxConfigurableParams.ParamType.Int256Range, bytes32(uint256(int256(-42)))
            ),
            "-42"
        );
        assertEq(
            TokenDataLib.decodeScalar(
                IAbxConfigurableParams.ParamType.Timestamp, bytes32(uint256(1_750_000_000))
            ),
            "1750000000"
        );
    }

    function test_KeyToString() public pure {
        assertEq(TokenDataLib.keyToString("palette"), "palette");
        assertEq(TokenDataLib.keyToString("seed"), "seed");
    }
}
