// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {SeedTraitsRenderer} from "../src/renderers/examples/SeedTraitsRenderer.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Seed source with per-token scripted seeds — trait bytes are hand-picked so every
///      expected value below is a hardcoded literal, not a re-derivation of the renderer.
contract ScriptedSeedSource is IAbxSeedSource {
    mapping(uint256 => bytes32) private _seeds;

    function set(uint256 tokenId, bytes32 value) external {
        _seeds[tokenId] = value;
    }

    function seed(uint256 tokenId, address) external view returns (bytes32) {
        return _seeds[tokenId];
    }
}

/// @notice {SeedTraitsRenderer} as the `attributes` field renderer on a real SeriesCode fixture.
///         The traits DESCRIBE the paired {SeedSvgRenderer} art — same seed bytes, same formulas —
///         so `Rings` here equals the ring count the SVG draws (proven jointly in SeedSvgRenderer.t).
contract SeedTraitsRendererTest is Test {
    bytes32 internal constant RENDERER_REP = "renderer";

    // Bytes drive [0]=Rings, [1]=Weight, [3]=Colorway (hue). Hand-picked to hit distinct buckets.
    bytes32 internal constant SEED_A = // [0]=0x07→Rings 3+(7%6)=4 · [1]=0x00→Weight Fine · [3]=0x10→hue 22→Ember
        0x0700001000000000000000000000000000000000000000000000000000000000;
    bytes32 internal constant SEED_B = // [0]=0x02→Rings 5 · [1]=0x05→Weight Bold · [3]=0x60→hue 135→Verdant
        0x0205006000000000000000000000000000000000000000000000000000000000;
    bytes32 internal constant SEED_C = // [0]=0x05→Rings 8 · [1]=0x01→Weight Medium · [3]=0xFF→hue 358→Rose
        0x050100FF00000000000000000000000000000000000000000000000000000000;

    SeriesCodeFactory internal factory;
    AbxMetadataRenderer internal metadataRenderer;
    SeedTraitsRenderer internal traitsRenderer;
    ScriptedSeedSource internal seedSource;
    SeriesCode internal nft;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");

    function setUp() public {
        factory = new SeriesCodeFactory();
        metadataRenderer = new AbxMetadataRenderer();
        traitsRenderer = new SeedTraitsRenderer();

        seedSource = new ScriptedSeedSource();
        seedSource.set(0, SEED_A);
        seedSource.set(1, SEED_B);
        seedSource.set(2, SEED_C);

        nft = _deploy(address(seedSource));

        vm.prank(owner);
        nft.mintMany(collector, 3);
    }

    function _deploy(address seedSourceAddr) internal returns (SeriesCode) {
        IAbxOnChainMetadata.FieldInput[] memory contractFields = new IAbxOnChainMetadata.FieldInput[](1);
        contractFields[0] = IAbxOnChainMetadata.FieldInput(
            "attributes", RENDERER_REP, abi.encode(address(traitsRenderer))
        );
        return SeriesCode(
            factory.deploy(
                SeriesCode.InitParams({
                    owner: owner,
                    name: "Seeded",
                    symbol: "SEED",
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

    function _render(uint256 tokenId) internal view returns (string memory) {
        (string memory contentType, bytes memory data) =
            traitsRenderer.render(address(nft), tokenId, "attributes");
        assertEq(contentType, "application/json");
        return string(data);
    }

    function _json(string memory uri) internal pure returns (string memory) {
        string memory prefix = "data:application/json;base64,";
        return string(Base64.decode(LibString.slice(uri, bytes(prefix).length, bytes(uri).length)));
    }

    // ── the derivations, byte-exact — and matched to the SVG ─────────────────--

    function test_KnownSeedDerivesExactTraitArray() public view {
        // Rings 4 (bare number, matches the 4 rings the SVG draws) · Weight Fine · Colorway Ember.
        // No palette set → no Palette trait — omission, not boilerplate.
        assertEq(
            _render(0),
            '[{"trait_type":"Rings","value":4},{"trait_type":"Weight","value":"Fine"},{"trait_type":"Colorway","value":"Ember"}]'
        );
    }

    function test_RingsIsNumericAndTracksSeedByte0() public view {
        assertEq(vm.parseJsonUint(string.concat('{"a":', _ringsOf(0), "}"), ".a"), 4);
        assertEq(vm.parseJsonUint(string.concat('{"a":', _ringsOf(1), "}"), ".a"), 5);
        assertEq(vm.parseJsonUint(string.concat('{"a":', _ringsOf(2), "}"), ".a"), 8);
    }

    function test_WeightAndColorwayBuckets() public view {
        assertTrue(LibString.contains(_render(1), '{"trait_type":"Weight","value":"Bold"}'), "seed B weight");
        assertTrue(LibString.contains(_render(1), '{"trait_type":"Colorway","value":"Verdant"}'), "seed B colorway");
        assertTrue(LibString.contains(_render(2), '{"trait_type":"Weight","value":"Medium"}'), "seed C weight");
        assertTrue(LibString.contains(_render(2), '{"trait_type":"Colorway","value":"Rose"}'), "seed C colorway");
    }

    // ── palette: two-scope read, canonical decode, omission ─────────────────--

    function test_PaletteContractParamAppendsDecodedTrait() public {
        vm.prank(owner);
        nft.setContractParam("palette", bytes32(uint256(0x0E1A40)));
        assertTrue(LibString.contains(_render(0), '{"trait_type":"Palette","value":"#0e1a40"}'), "palette appended");
    }

    function test_PaletteTokenScopeWinsOverContract() public {
        vm.startPrank(owner);
        nft.setContractParam("palette", bytes32(uint256(0x0E1A40)));
        nft.setTokenParam(0, "palette", bytes32(uint256(0xFF0000)));
        vm.stopPrank();
        assertTrue(LibString.contains(_render(0), '{"trait_type":"Palette","value":"#ff0000"}'), "token wins");
        assertTrue(LibString.contains(_render(1), '{"trait_type":"Palette","value":"#0e1a40"}'), "others keep contract palette");
    }

    // ── degrade behavior: missing state never reverts ───────────────────────--

    function test_MissingSeedOmitsSeedTraits() public {
        SeriesCode seedless = _deploy(address(0));
        vm.prank(owner);
        seedless.mint(collector);
        (, bytes memory bare) = traitsRenderer.render(address(seedless), 0, "attributes");
        assertEq(string(bare), "[]", "no seed + no palette: empty array, no revert");
    }

    function test_CollectionSurfaceSentinelReturnsEmptyArray() public {
        vm.prank(owner);
        nft.setContractParam("palette", bytes32(uint256(0x0E1A40)));
        (string memory contentType, bytes memory data) =
            traitsRenderer.render(address(nft), type(uint256).max, "attributes");
        assertEq(contentType, "application/json");
        assertEq(string(data), "[]");
    }

    function test_UnknownFieldRevertsAsMisconfiguration() public {
        vm.expectRevert(SeedTraitsRenderer.UnsupportedField.selector);
        traitsRenderer.render(address(nft), 0, "image");
    }

    // ── end to end through the canonical on-chain metadata renderer ─────────--

    function test_TokenURIEmbedsOnChainTraits() public view {
        string memory json = _json(nft.tokenURI(0));
        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "Rings");
        assertEq(vm.parseJsonUint(json, ".attributes[0].value"), 4); // numeric, unquoted
        assertEq(vm.parseJsonString(json, ".attributes[1].trait_type"), "Weight");
        assertEq(vm.parseJsonString(json, ".attributes[1].value"), "Fine");
        assertEq(vm.parseJsonString(json, ".attributes[2].trait_type"), "Colorway");
        assertEq(vm.parseJsonString(json, ".attributes[2].value"), "Ember");
    }

    function test_ProvenanceMarksAttributesAsRendererComputed() public view {
        assertTrue(
            LibString.contains(_json(nft.tokenURI(0)), '"field":"attributes","source":"renderer"'),
            "abx_provenance names the field renderer"
        );
    }

    /// @dev Extract just the `Rings` value substring for numeric assertions.
    function _ringsOf(uint256 tokenId) private view returns (string memory) {
        string memory s = _render(tokenId);
        uint256 start = LibString.indexOf(s, '"Rings","value":') + bytes('"Rings","value":').length;
        uint256 end = LibString.indexOf(s, "}", start);
        return LibString.slice(s, start, end);
    }
}
