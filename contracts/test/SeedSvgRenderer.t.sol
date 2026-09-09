// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {SeedSvgRenderer} from "../src/renderers/examples/SeedSvgRenderer.sol";
import {SeedTraitsRenderer} from "../src/renderers/examples/SeedTraitsRenderer.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

contract ScriptedSeedSource is IAbxSeedSource {
    mapping(uint256 => bytes32) private _seeds;

    function set(uint256 tokenId, bytes32 value) external {
        _seeds[tokenId] = value;
    }

    function seed(uint256 tokenId, address) external view returns (bytes32) {
        return _seeds[tokenId];
    }
}

/// @notice The in-chain SVG example, proven end to end: {SeedSvgRenderer} (image) + the paired
///         {SeedTraitsRenderer} (attributes) as collection-scope field renderers on a SeriesCode
///         with NO script and NO code — the whole `tokenURI` (name + image + traits) resolves from
///         chain via {AbxMetadataRenderer}, zero dependency outside the EVM. This is the "no-code
///         renderer-only" shape the CLI's `--image-renderer` lane targets; the contract layer
///         supporting it is exactly what this fixture demonstrates.
contract SeedSvgRendererTest is Test {
    bytes32 internal constant RENDERER_REP = "renderer";

    // seed[0] → ring count (3 + b%6); seed[1] → weight; seed[2] → rotation.
    bytes32 internal constant SEED_A = // 0x05 → 8 rings
        0x0507020000000000000000000000000000000000000000000000000000000000;
    bytes32 internal constant SEED_B = // 0x00 → 3 rings, different bytes → different art
        0x00010200000000000000000000000000000000000000000000000000000000FF;

    SeriesCodeFactory internal factory;
    AbxMetadataRenderer internal metadataRenderer;
    SeedSvgRenderer internal svg;
    SeedTraitsRenderer internal traits;
    ScriptedSeedSource internal seedSource;
    SeriesCode internal nft;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");

    function setUp() public {
        factory = new SeriesCodeFactory();
        metadataRenderer = new AbxMetadataRenderer();
        svg = new SeedSvgRenderer();
        traits = new SeedTraitsRenderer();

        seedSource = new ScriptedSeedSource();
        seedSource.set(0, SEED_A);
        seedSource.set(1, SEED_B);

        nft = _deploy(address(seedSource));
        vm.prank(owner);
        nft.mintMany(collector, 2);
    }

    /// @dev image + attributes both `renderer`-rep collection fields; NO code/script field.
    function _deploy(address seedSourceAddr) internal returns (SeriesCode) {
        IAbxOnChainMetadata.FieldInput[] memory contractFields = new IAbxOnChainMetadata.FieldInput[](2);
        contractFields[0] =
            IAbxOnChainMetadata.FieldInput("image", RENDERER_REP, abi.encode(address(svg)));
        contractFields[1] =
            IAbxOnChainMetadata.FieldInput("attributes", RENDERER_REP, abi.encode(address(traits)));
        return SeriesCode(
            factory.deploy(
                SeriesCode.InitParams({
                    owner: owner,
                    name: "In-Chain Orbit",
                    symbol: "ORB",
                    tokenURIBase: "",
                    tokenURIRenderer: address(metadataRenderer),
                    contractURIBase: "",
                    contractURIRenderer: address(metadataRenderer),
                    royaltyReceiver: owner,
                    royaltyBps: 500,
                    maxRoyaltyBps: 1000,
                    burnable: false,
                    transferValidator: address(0),
                    maxInvocations: 2,
                    primaryPayee: address(0),
                    minter: address(0),
                    paused: false,
                    seedSource: seedSourceAddr,
                    disableTokenOwnerDelegation: false,
                    mintTo: address(0),
                    mintCount: 0,
                    tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
                    contractFields: contractFields
                })
            )
        );
    }

    function _svg(uint256 tokenId) internal view returns (string memory) {
        (string memory ct, bytes memory data) = svg.render(address(nft), tokenId, "image");
        assertEq(ct, "image/svg+xml");
        return string(data);
    }

    function _json(string memory uri) internal pure returns (string memory) {
        string memory prefix = "data:application/json;base64,";
        return string(Base64.decode(LibString.slice(uri, bytes(prefix).length, bytes(uri).length)));
    }

    // ── the renderer directly ────────────────────────────────────────────────

    function test_RenderReturnsValidSvg() public view {
        string memory s = _svg(0);
        assertTrue(LibString.startsWith(s, "<svg"), "starts with <svg");
        assertTrue(LibString.endsWith(s, "</svg>"), "ends with </svg>");
        assertTrue(LibString.contains(s, "<circle"), "has rings");
    }

    function test_PaletteTintsTheField() public {
        // no palette set → default fill.
        assertTrue(LibString.contains(_svg(0), 'fill="#0e1a40"'), "default palette fill");
        // a token-scope palette flows into the field.
        vm.prank(owner);
        nft.setTokenParam(0, "palette", bytes32(uint256(0xFF0000)));
        assertTrue(LibString.contains(_svg(0), 'fill="#ff0000"'), "palette PostParam tints output");
        // other tokens unaffected (per-token param scope).
        assertTrue(LibString.contains(_svg(1), 'fill="#0e1a40"'), "token 1 keeps default");
    }

    function test_SeedDrivesGeometry_DifferentSeedsDifferentArt() public view {
        // SEED_A byte[0]=0x05 → 3+(5%6)=8 rings; SEED_B byte[0]=0x00 → 3 rings.
        assertTrue(_countCircles(_svg(0)) == 9, "8 rings + center dot"); // seed A
        assertTrue(_countCircles(_svg(1)) == 4, "3 rings + center dot"); // seed B
        assertTrue(
            keccak256(bytes(_svg(0))) != keccak256(bytes(_svg(1))), "distinct seeds -> distinct art"
        );
    }

    function test_MissingSeedStillRenders() public {
        SeriesCode seedless = _deploy(address(0)); // no seed source
        vm.prank(owner);
        seedless.mint(collector);
        (, bytes memory data) = svg.render(address(seedless), 0, "image");
        assertTrue(LibString.startsWith(string(data), "<svg"), "fallback (keccak(tokenId)) renders");
    }

    function test_CollectionSurfaceReturnsCard() public view {
        (string memory ct, bytes memory data) = svg.render(address(nft), type(uint256).max, "image");
        assertEq(ct, "image/svg+xml");
        assertTrue(LibString.contains(string(data), "<text"), "collection card has a label");
    }

    function test_UnknownFieldReverts() public {
        vm.expectRevert(SeedSvgRenderer.UnsupportedField.selector);
        svg.render(address(nft), 0, "attributes");
    }

    // ── end to end: the fully in-chain tokenURI ────────────────────────────────

    function test_TokenURIEmbedsOnChainSvgImageAndTraits() public view {
        string memory json = _json(nft.tokenURI(0));
        // image is a data:image/svg+xml URI assembled on-chain — no http(s) anywhere.
        string memory image = vm.parseJsonString(json, ".image");
        assertTrue(
            LibString.startsWith(image, "data:image/svg+xml;base64,"), "image is an on-chain SVG data URI"
        );
        string memory decoded = string(
            Base64.decode(
                LibString.slice(image, bytes("data:image/svg+xml;base64,").length, bytes(image).length)
            )
        );
        assertTrue(LibString.startsWith(decoded, "<svg"), "decoded image is an SVG document");
        // traits also on-chain (from the paired renderer) — and they DESCRIBE this image: the first
        // trait is Rings, whose value equals the ring count drawn above (coherence by construction).
        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "Rings");
        assertEq(vm.parseJsonUint(json, ".attributes[0].value"), _countCircles(_svg(0)) - 1); // rings = circles − center dot
    }

    function test_TokenURIHasNoExternalUrls() public view {
        // the whole point: zero dependency outside the EVM.
        string memory json = _json(nft.tokenURI(0));
        assertFalse(LibString.contains(json, "http://"), "no http url in tokenURI");
        assertFalse(LibString.contains(json, "https://"), "no https url in tokenURI");
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    function _countCircles(string memory s) internal pure returns (uint256 n) {
        bytes memory b = bytes(s);
        bytes memory needle = bytes("<circle");
        for (uint256 i = 0; i + needle.length <= b.length; ++i) {
            bool hit = true;
            for (uint256 j = 0; j < needle.length; ++j) {
                if (b[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) ++n;
        }
    }
}
