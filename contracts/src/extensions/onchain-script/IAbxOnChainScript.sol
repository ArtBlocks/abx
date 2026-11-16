// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxOnChainScript — On-Chain Script extension vocabulary (Register 2)
/// @notice A project's program stored on-chain in chunks, introspectably (not a co-opted param
///         key). Chunks are too large to log, so `ScriptUpdated` carries the changed `index` —
///         an indexer re-reads **just that chunk** (+ `scriptChunkCount()` for length), O(1),
///         never a full re-read. The storage mechanism (SSTORE2, raw, future stores) is the
///         implementation's; this is the on-chain form of a project's content, vs. an off-chain
///         `code` field pointer.
interface IAbxOnChainScript {
    // Errors raised by the write paths and the bounds-checked read, which run in {AbxCodeLib} by
    // delegatecall. Declared here so they decode against every composing token's ABI.

    /// @notice The script is locked; no chunk can be written, removed or re-locked.
    error ScriptIsLocked();
    /// @notice A chunk index is past the end (or there is no chunk to remove).
    error ScriptIndexOutOfRange();
    /// @notice A script chunk carried no bytes.
    error EmptyScriptChunk();

    /// @notice The chunk at `index` was written or removed — re-read just that chunk.
    event ScriptUpdated(uint256 index);

    /// @notice The script is frozen permanently; chunks are now immutable.
    event ScriptLocked();

    /// @notice Number of script chunks. The full program is chunks `0..count-1` joined with a
    ///         single `\n` between consecutive chunks — the join the on-chain generator and the
    ///         resolver both apply. Plain concatenation is NOT the program: a chunk boundary that
    ///         falls after a line comment would swallow the next chunk's first line.
    function scriptChunkCount() external view returns (uint256);

    /// @notice One chunk's content, by index.
    function scriptChunk(uint256 index) external view returns (bytes memory);

    /// @notice Whether the script is permanently frozen.
    function scriptLocked() external view returns (bool);
}
