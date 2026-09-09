// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {AbxChunkStore} from "../src/renderers/AbxChunkStore.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice Empirical inline-vs-SSTORE2 crossover for storing image bytes on-chain.
///         Measures EXECUTION gas (SSTORE storage cost for inline; CREATE/code-deposit for
///         the chunk store). Top-level-tx calldata cost (~16 gas/byte) is roughly equal for
///         both paths (both send the bytes once) and is charged outside `gasleft()`, so it's
///         excluded here — the storage-vs-code-deposit gap below is the real differentiator.
///         NOTE: the SSTORE2 total in practice also pays one extra tx intrinsic (~21,000).
contract GasCrossoverTest is Test {
    bytes32 internal constant IMAGE = "image";
    bytes32 internal constant INLINE = "inline";
    bytes32 internal constant READER = "reader";

    OneOfOneImageFactory internal factory;
    address internal owner = makeAddr("owner");

    function setUp() public {
        factory = new OneOfOneImageFactory();
    }

    function _deploy() internal returns (OneOfOneImage token) {
        OneOfOneImage.InitParams memory p = OneOfOneImage.InitParams({
            owner: owner,
            mintTo: owner,
            name: "Gas",
            symbol: "GAS",
            tokenURIBase: "",
            tokenURIRenderer: address(0),
            contractURIBase: "",
            contractURIRenderer: address(0),
            royaltyReceiver: owner,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
        token = OneOfOneImage(factory.deploy(p));
    }

    function _blob(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        // 'a' — non-zero, models SVG text
        for (uint256 i; i < n; ++i) {
            b[i] = 0x61;
        }
    }

    /// Execution gas to store `n` bytes inline (SSTORE into the image field).
    function _inlineGas(uint256 n) internal returns (uint256) {
        OneOfOneImage token = _deploy();
        bytes memory data = _blob(n);
        vm.prank(owner);
        uint256 g0 = gasleft();
        token.setTokenField(0, IMAGE, INLINE, data);
        return g0 - gasleft();
    }

    /// Execution gas for the SSTORE2 path: writeContent (1 chunk + manifest) + store the
    /// ~64-byte reader pointer. (+21,000 added by the caller for the extra tx intrinsic.)
    function _sstore2Gas(uint256 n) internal returns (uint256) {
        AbxChunkStore store = new AbxChunkStore();
        bytes[] memory datas = new bytes[](1);
        datas[0] = _blob(n);
        bool[] memory compressed = new bool[](1);
        uint256 g1 = gasleft();
        address manifest = store.writeContent(datas, compressed);
        uint256 writeGas = g1 - gasleft();

        OneOfOneImage token = _deploy();
        bytes memory readerVal = abi.encode(address(store), manifest);
        vm.prank(owner);
        uint256 g2 = gasleft();
        token.setTokenField(0, IMAGE, READER, readerVal);
        return writeGas + (g2 - gasleft());
    }

    function test_Crossover() public {
        uint256[7] memory sizes = [uint256(128), 256, 512, 1024, 2048, 4096, 8192];
        console2.log("size | inline_gas | sstore2_gas(+21k tx)");
        for (uint256 s; s < sizes.length; ++s) {
            uint256 n = sizes[s];
            uint256 inlineGas = _inlineGas(n);
            uint256 sstore2Gas = _sstore2Gas(n) + 21000;
            console2.log(n, inlineGas, sstore2Gas);
        }
        // The crux: beyond ~0.5 KB, SSTORE2 (even uncompressed, even paying the extra tx) is
        // cheaper than inline — and the gap only widens with size. Guard that it stays true.
        assertLt(_sstore2Gas(1024) + 21000, _inlineGas(1024), "SSTORE2 should beat inline at 1KB");
        assertLt(_sstore2Gas(4096) + 21000, _inlineGas(4096), "SSTORE2 should beat inline at 4KB");
    }
}
