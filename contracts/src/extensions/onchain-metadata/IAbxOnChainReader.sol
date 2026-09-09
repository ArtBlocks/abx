// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxOnChainReader — the on-chain decoder interface for metadata content
/// @notice A field whose `representation` is `"reader"` stores `abi.encode(address reader,
///         address pointer)` as its value. Anyone — an indexer via `eth_call`, or another
///         contract — gets the field's content by calling `IAbxOnChainReader(reader).read(pointer)`.
///         The reader encapsulates BOTH the storage mechanism (e.g. SSTORE2, possibly a manifest
///         of chunks) and any on-chain decoding (e.g. Solady `LibZip` decompression). So the
///         metadata store stays storage- and codec-agnostic, and a new on-chain scheme is just a
///         new reader contract pointed at by `value` — no protocol or store change.
/// @dev `pointer` is "where the data is" — a data contract the reader knows how to read; how it's
///      stored (SSTORE2, chunked, compressed) is the reader's private detail, never leaked into
///      the metadata store's value (which carries only the two addresses).
interface IAbxOnChainReader {
    /// @notice Read + fully decode the content stored at `pointer`.
    function read(address pointer) external view returns (bytes memory);
}
