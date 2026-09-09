// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LibZip} from "solady/utils/LibZip.sol";
import {AbxChunkStore} from "../src/renderers/AbxChunkStore.sol";

/// @notice Multi-chunk store: raw + FastLZ stitching, single- and multi-chunk, round-trips.
contract AbxChunkStoreTest is Test {
    AbxChunkStore internal store;

    function setUp() public {
        store = new AbxChunkStore();
    }

    function _manifest(AbxChunkStore.Chunk[] memory chunks) internal returns (address) {
        return store.writeManifest(chunks);
    }

    function test_SingleRawChunk_RoundTrips() public {
        bytes memory content = bytes("a single chunk of on-chain content");
        AbxChunkStore.Chunk[] memory chunks = new AbxChunkStore.Chunk[](1);
        chunks[0] = AbxChunkStore.Chunk({pointer: store.writeChunk(content), compressed: false});
        assertEq(store.read(_manifest(chunks)), content);
    }

    function test_MultiRawChunk_StitchesInOrder() public {
        bytes memory a = bytes("first-half|");
        bytes memory b = bytes("second-half");
        AbxChunkStore.Chunk[] memory chunks = new AbxChunkStore.Chunk[](2);
        chunks[0] = AbxChunkStore.Chunk({pointer: store.writeChunk(a), compressed: false});
        chunks[1] = AbxChunkStore.Chunk({pointer: store.writeChunk(b), compressed: false});
        assertEq(store.read(_manifest(chunks)), bytes.concat(a, b));
    }

    function test_FastLZChunk_DecompressesOnRead() public {
        // Highly compressible content; compress with Solady's own flzCompress (the matched
        // encoder) so the read path's flzDecompress is exercised end to end.
        bytes memory content = bytes(
            "the the the the the the the the the the the the the the the the the the on-chain on-chain on-chain"
        );
        bytes memory packed = LibZip.flzCompress(content);
        assertLt(packed.length, content.length, "should actually compress");

        AbxChunkStore.Chunk[] memory chunks = new AbxChunkStore.Chunk[](1);
        chunks[0] = AbxChunkStore.Chunk({pointer: store.writeChunk(packed), compressed: true});
        assertEq(store.read(_manifest(chunks)), content);
    }

    function test_MixedRawAndCompressedChunks() public {
        bytes memory raw = bytes("[header]");
        bytes memory body = bytes(
            "body body body body body body body body body body body body body body body body body body"
        );
        bytes memory packed = LibZip.flzCompress(body);

        AbxChunkStore.Chunk[] memory chunks = new AbxChunkStore.Chunk[](2);
        chunks[0] = AbxChunkStore.Chunk({pointer: store.writeChunk(raw), compressed: false});
        chunks[1] = AbxChunkStore.Chunk({pointer: store.writeChunk(packed), compressed: true});
        assertEq(store.read(_manifest(chunks)), bytes.concat(raw, body));
    }

    function test_LargeTwoChunk_RoundTrips() public {
        // ~30 kB split into two ~15 kB chunks — the motivating case.
        bytes memory half = new bytes(15000);
        for (uint256 i; i < half.length; ++i) {
            half[i] = bytes1(uint8(65 + (i % 26)));
        }
        AbxChunkStore.Chunk[] memory chunks = new AbxChunkStore.Chunk[](2);
        chunks[0] = AbxChunkStore.Chunk({pointer: store.writeChunk(half), compressed: false});
        chunks[1] = AbxChunkStore.Chunk({pointer: store.writeChunk(half), compressed: false});
        bytes memory got = store.read(_manifest(chunks));
        assertEq(got.length, 30000);
        assertEq(got, bytes.concat(half, half));
    }
    /// L-02: `read` used to be `out = bytes.concat(out, part)` per chunk — quadratic, because each
    /// iteration reallocates and recopies the whole accumulated prefix. For N equal chunks of size S
    /// the allocation grows as S·N(N+1)/2 while the output is only S·N.
    ///
    /// This asserts the OUTPUT is exact across many chunks, including the alignment case that a
    /// hand-rolled 32-byte-at-a-time copy gets wrong: parts of 1 and 63 bytes sum to an aligned 64,
    /// so the final word write lands one byte past an exactly-sized allocation.
    function test_ManyChunks_ConcatenateExactlyAcrossUnalignedBoundaries() public {
        uint256 n = 24;
        AbxChunkStore.Chunk[] memory chunks = new AbxChunkStore.Chunk[](n);
        bytes memory expected;
        for (uint256 i; i < n; ++i) {
            // deliberately unaligned, varying lengths — 1, 63, 2, 62, …
            uint256 len = (i % 2 == 0) ? 1 + (i / 2) : 63 - (i / 2);
            bytes memory part = new bytes(len);
            for (uint256 k; k < len; ++k) part[k] = bytes1(uint8((i * 7 + k) % 251));
            chunks[i] = AbxChunkStore.Chunk({pointer: store.writeChunk(part), compressed: false});
            expected = bytes.concat(expected, part);
        }
        address manifest = store.writeManifest(chunks);
        assertEq(store.read(manifest), expected, "every byte, in order, with no overrun or truncation");
    }

    /// A compressed chunk's manifest length is its COMPRESSED size, so the pre-allocation has to be
    /// measured after decompression — otherwise the buffer is short and the tail is lost.
    function test_CompressedChunksAreMeasuredAfterDecompression() public {
        bytes memory raw = new bytes(4096); // highly compressible
        for (uint256 i; i < raw.length; ++i) raw[i] = bytes1(uint8(i % 4));

        AbxChunkStore.Chunk[] memory chunks = new AbxChunkStore.Chunk[](2);
        chunks[0] = AbxChunkStore.Chunk({pointer: store.writeChunk(LibZip.flzCompress(raw)), compressed: true});
        chunks[1] = AbxChunkStore.Chunk({pointer: store.writeChunk(bytes("tail")), compressed: false});

        assertEq(store.read(store.writeManifest(chunks)), bytes.concat(raw, bytes("tail")));
    }

}
