// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MyRenderer} from "../src/MyRenderer.sol";
import {MyTraits} from "../src/MyTraits.sol";
import {IAbxParams} from "abx-contracts/src/extensions/params/IAbxParams.sol";

/// A tiny stand-in for the ABX contract's param surface, so the renderers can be tested in
/// isolation — set a seed / palette (or don't) and assert the renderer behaves.
contract MockParams is IAbxParams {
    mapping(uint256 => mapping(bytes32 => bytes32)) private tv;
    mapping(uint256 => mapping(bytes32 => bool)) private ts;
    mapping(bytes32 => bytes32) private cv;
    mapping(bytes32 => bool) private cs;
    // `Bytes`/`String` params: the bytes32 holds keccak(content), the content lives here.
    mapping(uint256 => mapping(bytes32 => bytes)) private td;
    mapping(bytes32 => bytes) private cd;

    function setToken(uint256 id, bytes32 key, bytes32 val) external { tv[id][key] = val; ts[id][key] = true; }
    function setContract(bytes32 key, bytes32 val) external { cv[key] = val; cs[key] = true; }

    /// Set a payload-typed (`Bytes`/`String`) param the way the real contract does: the scalar slot
    /// carries the keccak COMMITMENT and `valueIsHash` is true, so a renderer that reads the bytes32
    /// gets a hash — the data reader is the only way to the content.
    function setTokenData(uint256 id, bytes32 key, bytes memory content) external {
        td[id][key] = content;
        tv[id][key] = keccak256(content);
        ts[id][key] = true;
    }
    function setContractData(bytes32 key, bytes memory content) external {
        cd[key] = content;
        cv[key] = keccak256(content);
        cs[key] = true;
    }

    function tokenParam(uint256 id, bytes32 key) external view returns (bytes32, bool, bool) {
        return (tv[id][key], td[id][key].length > 0, ts[id][key]);
    }
    function contractParam(bytes32 key) external view returns (bytes32, bool, bool) {
        return (cv[key], cd[key].length > 0, cs[key]);
    }
    function tokenParamData(uint256 id, bytes32 key) external view returns (bytes memory) {
        return td[id][key];
    }
    function contractParamData(bytes32 key) external view returns (bytes memory) {
        return cd[key];
    }
    function tokenParamKeys(uint256) external pure returns (bytes32[] memory) { return new bytes32[](0); }
    function tokenParamKeysPaged(uint256, uint256, uint256)
        external pure returns (bytes32[] memory keys, uint256 total)
    { return (new bytes32[](0), 0); }
    function contractParamKeys() external pure returns (bytes32[] memory) { return new bytes32[](0); }
    function contractParamKeysPaged(uint256, uint256)
        external pure returns (bytes32[] memory keys, uint256 total)
    { return (new bytes32[](0), 0); }
}

contract MyRendererTest is Test {
    MyRenderer img;
    MyTraits traits;
    MockParams params;

    bytes32 constant IMAGE = "image";
    bytes32 constant ATTRIBUTES = "attributes";

    function setUp() public {
        img = new MyRenderer();
        traits = new MyTraits();
        params = new MockParams();
    }

    function _has(bytes memory hay, string memory needle) internal pure returns (bool) {
        bytes memory n = bytes(needle);
        if (n.length == 0 || hay.length < n.length) return n.length == 0;
        for (uint256 i = 0; i <= hay.length - n.length; ++i) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; ++j) if (hay[i + j] != n[j]) { ok = false; break; }
            if (ok) return true;
        }
        return false;
    }

    function test_image_contentTypeAndSvg() public {
        params.setToken(0, "seed", bytes32(uint256(0x1234)));
        (string memory ct, bytes memory data) = img.render(address(params), 0, IMAGE);
        assertEq(ct, "image/svg+xml");
        assertTrue(_has(data, "<svg"));
        assertTrue(_has(data, "</svg>"));
    }

    function test_palette_tintsTheImage() public {
        params.setToken(0, "seed", bytes32(uint256(0x1234)));
        params.setToken(0, "palette", bytes32(uint256(0xff3366))); // RGB in low 3 bytes
        (, bytes memory data) = img.render(address(params), 0, IMAGE);
        assertTrue(_has(data, "#ff3366"));
    }

    function test_neverReverts_noSeedNoPalette() public view {
        // unset seed + palette → deterministic fallback, still a valid SVG, no revert
        (string memory ct, bytes memory data) = img.render(address(params), 7, IMAGE);
        assertEq(ct, "image/svg+xml");
        assertTrue(_has(data, "<svg"));
    }

    function test_neverReverts_collectionSurface() public view {
        // tokenId == type(uint256).max is the collection surface (contractURI) — MUST NOT revert
        (string memory ct, bytes memory data) = img.render(address(params), type(uint256).max, IMAGE);
        assertEq(ct, "image/svg+xml");
        assertTrue(_has(data, "<svg"));
    }

    function test_unsupportedField_reverts() public {
        vm.expectRevert(MyRenderer.UnsupportedField.selector);
        img.render(address(params), 0, ATTRIBUTES);
    }

    function test_traits_coherentWithImage() public {
        bytes32 seed = bytes32(uint256(0xABCDEF));
        params.setToken(0, "seed", seed);
        (string memory ct, bytes memory data) = traits.render(address(params), 0, ATTRIBUTES);
        assertEq(ct, "application/json");
        // Rings trait must equal the image's ring count: 3 + seed[0] % 6
        uint256 rings = 3 + (uint8(seed[0]) % 6);
        assertTrue(_has(data, string.concat('"value":"', vm.toString(rings), '"')));
        assertTrue(_has(data, "Rings"));
    }

    function test_traits_collectionSurface_emptyArray() public view {
        (, bytes memory data) = traits.render(address(params), type(uint256).max, ATTRIBUTES);
        assertEq(string(data), "[]");
    }

    /// The whole point: render() must NOT revert for ANY seed / tokenId. A revert here bricks tokenURI.
    function testFuzz_imageNeverReverts(uint256 tokenId, bytes32 seed, uint24 rgb) public {
        params.setToken(tokenId, "seed", seed);
        params.setToken(tokenId, "palette", bytes32(uint256(rgb)));
        (, bytes memory data) = img.render(address(params), tokenId, IMAGE);
        assertTrue(data.length > 0);
    }

    /// READING A PAYLOAD PARAM (`Bytes`/`String`) — the pattern for carrying an actual work
    /// payload on-chain. The scalar reader hands you a keccak COMMITMENT with `valueIsHash == true`;
    /// the content only comes from `tokenParamData`. If your renderer reads a `Bytes` param through
    /// `tokenParam` it will draw from a hash and produce garbage, silently — hence this test.
    function test_bytesParam_readViaDataReader() public {
        bytes memory grid = hex"00112233445566778899aabbccddeeff";
        params.setTokenData(0, "grid", grid);

        // The scalar surface: a commitment, explicitly flagged as one — NOT the content.
        (bytes32 value, bool valueIsHash, bool isSet) = IAbxParams(address(params)).tokenParam(0, "grid");
        assertTrue(isSet);
        assertTrue(valueIsHash, "a Bytes param reports valueIsHash: read the data instead");
        assertEq(value, keccak256(grid));

        // The data surface: the real bytes, verifiable against that commitment.
        bytes memory got = IAbxParams(address(params)).tokenParamData(0, "grid");
        assertEq(got, grid);
        assertEq(keccak256(got), value, "content must match the on-chain commitment");
    }

    /// An unset payload param returns empty bytes — your "use a default" signal, never a revert.
    function test_bytesParam_unsetIsEmpty() public view {
        assertEq(IAbxParams(address(params)).tokenParamData(0, "grid").length, 0);
        assertEq(IAbxParams(address(params)).contractParamData("grid").length, 0);
    }
}
