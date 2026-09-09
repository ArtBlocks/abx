// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {SSTORE2} from "solady/utils/SSTORE2.sol";
import {LibZip} from "solady/utils/LibZip.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";

import {IAbxOnChainReader} from "../extensions/onchain-metadata/IAbxOnChainReader.sol";
import {DynamicBuffer} from "../libraries/DynamicBuffer.sol";

/// @title AbxChunkStore — multi-chunk on-chain content store + reader (an IAbxOnChainReader)
/// @notice Stores arbitrary content as one or more immutable SSTORE2 data contracts and
///         stitches them back on read. Stateless and shared — deploy once per chain, then
///         any number of tokens reference it as their field's `reader`, with the `pointer`
///         being a manifest this store produced. The on-chain realization of the `reader`
///         representation; the storage mechanism (SSTORE2) and on-chain codec (FastLZ) are
///         **internal here**, never in the token or the protocol — so there is no
///         SSTORE2/FastLZ lock-in: a future store with a different mechanism is just a new
///         `reader` address tokens opt into.
/// @dev Compression is **per-chunk** and applied off-chain by the caller (the CLI), which
///      flags each chunk in the manifest; this store only *decompresses* on read (FastLZ is
///      on-chain-decodable via Solady `LibZip`). gzip is NOT handled here — it can't be
///      decoded on-chain, so gzip content is signaled by the field's representation tag
///      (`reader-gzip`) and inflated off-chain; to this store, gzip'd bytes are just bytes.
///      `read()` always returns the finished, on-chain-decoded content (single- and
///      multi-chunk are one path; N=1 is the trivial case).
///
///      Batching: the store is {Multicallable}, so a writer can land every `writeChunk`
///      plus the final `writeManifest` for a piece of content in one atomic transaction
///      (gas permitting — the off-chain caller packs writes under a per-tx gas budget and
///      splits into more multicalls as needed). The writes are permissionless and stateless,
///      so the batch grants no authority; the returned chunk/manifest addresses come back in
///      the multicall results and are also emitted as events for indexing.
contract AbxChunkStore is IAbxOnChainReader, Multicallable {
    /// @notice One stored chunk: its SSTORE2 data contract + whether it's FastLZ-compressed.
    struct Chunk {
        address pointer;
        bool compressed; // true ⇒ FastLZ; `read` runs LibZip.flzDecompress on it
    }

    /// @notice A content chunk was written to its own SSTORE2 data contract.
    event ChunkWritten(address indexed pointer, uint256 storedSize);
    /// @notice A manifest (the ordered chunk list a `reader` field points at) was written.
    event ManifestWritten(address indexed manifest, uint256 chunkCount);

    /// @notice `writeContent` was given chunk data and flags of differing lengths.
    error LengthMismatch();

    /// @notice Write a whole piece of content — every chunk plus the manifest — in ONE
    ///         call. Each `datas[i]` is stored verbatim as its own SSTORE2 data contract
    ///         and flagged `compressed[i]` (true ⇒ FastLZ, decompressed on read); the
    ///         manifest is then assembled from the real chunk addresses and written.
    ///         Returns the manifest address to reference as a `reader` field's pointer.
    /// @dev The one-transaction path for content that fits in a single tx's gas: atomic
    ///      and prediction-free (no need to know chunk addresses ahead of time, no nonce
    ///      races). Content too large for one tx instead uses {writeChunk} across batched
    ///      `multicall`s (collecting the returned addresses) followed by {writeManifest}.
    function writeContent(bytes[] calldata datas, bool[] calldata compressed)
        external
        returns (address manifest)
    {
        if (datas.length != compressed.length) revert LengthMismatch();
        Chunk[] memory chunks = new Chunk[](datas.length);
        for (uint256 i; i < datas.length; ++i) {
            address pointer = SSTORE2.write(datas[i]);
            emit ChunkWritten(pointer, datas[i].length);
            chunks[i] = Chunk({pointer: pointer, compressed: compressed[i]});
        }
        manifest = SSTORE2.write(abi.encode(chunks));
        emit ManifestWritten(manifest, chunks.length);
    }

    /// @notice Write one content chunk verbatim as an SSTORE2 data contract. The caller
    ///         pre-compresses (FastLZ) if it wants and records that in the manifest; this
    ///         store keeps the bytes exactly as given.
    function writeChunk(bytes calldata data) external returns (address pointer) {
        pointer = SSTORE2.write(data);
        emit ChunkWritten(pointer, data.length);
    }

    /// @notice Write the manifest (the ordered chunk list) as an SSTORE2 blob. Its address
    ///         is the `pointer` a `reader` field references (`value = abi.encode(store, manifest)`).
    function writeManifest(Chunk[] calldata chunks) external returns (address manifest) {
        manifest = SSTORE2.write(abi.encode(chunks));
        emit ManifestWritten(manifest, chunks.length);
    }

    /// @inheritdoc IAbxOnChainReader
    /// @dev `pointer` is a manifest written by {writeManifest}. Reads every chunk,
    ///      FastLZ-decompresses the flagged ones, and concatenates — the finished content.
    function read(address pointer) external view returns (bytes memory) {
        Chunk[] memory chunks = abi.decode(SSTORE2.read(pointer), (Chunk[]));

        // Resolve every part FIRST, then allocate once and copy each part exactly once.
        //
        // This used to be `out = bytes.concat(out, part)` in the loop, which is quadratic in a way
        // that bites hard at real chunk counts: each iteration allocates a fresh buffer and copies
        // the whole accumulated prefix, and the old buffers are never reclaimed. For N equal chunks
        // of size S the allocated prefix grows as S·N(N+1)/2 while the output is only S·N — 32
        // chunks of 20 KB produce 640 KB of content from roughly 10.6 MB of allocation, and EVM
        // memory expansion alone runs past 200 million gas before a single SSTORE2 read is paid for.
        //
        // Reading into an array, summing, and copying once is linear in the output and simpler to
        // reason about. Decompression happens in the first pass so a compressed chunk's TRUE length
        // is known before allocation — the manifest records compressed sizes, not final ones.
        bytes[] memory parts = new bytes[](chunks.length);
        uint256 total;
        for (uint256 i; i < chunks.length; ++i) {
            bytes memory part = SSTORE2.read(chunks[i].pointer);
            if (chunks[i].compressed) part = LibZip.flzDecompress(part);
            parts[i] = part;
            unchecked {
                total += part.length;
            }
        }

        // `DynamicBuffer.allocate` + `appendSafe` rather than a hand-rolled word copy: appending
        // 32 bytes at a time into an exactly-sized array overruns it whenever a part boundary is
        // unaligned (total 64 from parts of 1 and 63 writes one byte past the allocation), and the
        // repo already uses this measure-then-allocate-once helper in AbxGenerator.
        bytes memory out = DynamicBuffer.allocate(total);
        for (uint256 i; i < parts.length; ++i) {
            DynamicBuffer.appendSafe(out, parts[i]);
        }
        return out;
    }

    /// @notice Decode a manifest into its chunk list (introspection; `read` is the content path).
    function manifestChunks(address manifest) external view returns (Chunk[] memory) {
        return abi.decode(SSTORE2.read(manifest), (Chunk[]));
    }
}
