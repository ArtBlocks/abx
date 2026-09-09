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
    /// @notice The chunk at `index` was written or removed — re-read just that chunk.
    event ScriptUpdated(uint256 index);

    /// @notice The script is frozen permanently; chunks are now immutable.
    event ScriptLocked();

    /// @notice Number of script chunks (concatenate `0..count-1` for the full program).
    function scriptChunkCount() external view returns (uint256);

    /// @notice One chunk's content, by index.
    function scriptChunk(uint256 index) external view returns (bytes memory);

    /// @notice Whether the script is permanently frozen.
    function scriptLocked() external view returns (bool);
}
