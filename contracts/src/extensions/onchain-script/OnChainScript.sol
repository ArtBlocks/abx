// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxOnChainScript} from "./IAbxOnChainScript.sol";
import {AbxCodeDelegate} from "../code-custody/AbxCodeDelegate.sol";
import {AbxCodeLib} from "../../libraries/AbxCodeLib.sol";

/// @title OnChainScript — the ABX On-Chain Script extension (Register 2), as a mixin
/// @notice A token opts into on-chain program custody by inheriting this: the script lives in
///         ordered SSTORE2 chunks, written/replaced by index, appendable, poppable from the
///         end (the list stays dense — index is load-bearing), and permanently lockable. A
///         generator assembles dependencies (index 0 = runtime, by convention) → this script.
/// @dev Chunks are typically written post-deploy under a gas budget via `multicall` — a script
///      is far too large for a fat `initialize`. Read surface → non-zero ERC-165 id. Storage is
///      ERC-7201 (`OnChainScriptStorage`). Self-registers its version in `_initOnChainScript`.
///      Both the write paths **and the reads** live in {AbxCodeLib} — a shared external library,
///      delegatecalled, so storage stays in this token's namespace and events log from the token
///      (EIP-170 is why it's a library). The reads go through {AbxCodeDelegate}'s raw-calldata
///      passthrough rather than typed calls: see that contract for why, and for the ABI coupling it
///      creates.
abstract contract OnChainScript is AbxBeaconCore, Ownable, AbxCodeDelegate, IAbxOnChainScript {
    /// @dev keccak256("abx.extension.onchain-script") — permanent extension id.
    bytes32 private constant ID =
        0xe8a80ea5b2e256dbfd75524b770700fcc33748c25ec4d2653106462a151e1d55;

    /// @dev Current implemented version (bumps when the interface or semantics change).
    uint16 private constant VERSION = 1;

    /// @notice Write index must be ≤ count (replace or append); reads must be < count.
    /// @dev Kept declared here (not thrown here) so it stays in every composing token's ABI: both
    ///      the writes and the bounds-checked `scriptChunk` read now revert from {AbxCodeLib}, whose
    ///      identically-named error has the identical selector.
    error ScriptIndexOutOfRange();

    /// @notice Owner writes/replaces the chunk at `index` (`== count` appends).
    function setScriptChunk(uint256 index, bytes calldata chunk) external onlyOwner {
        AbxCodeLib.setScriptChunk(index, chunk);
    }

    /// @notice Owner removes the LAST chunk (the list stays dense; order is load-bearing).
    function removeLastScriptChunk() external onlyOwner {
        AbxCodeLib.removeLastScriptChunk();
    }

    /// @notice Owner freezes the script permanently.
    function lockScript() external onlyOwner {
        AbxCodeLib.lockScript();
    }

    /// @inheritdoc IAbxOnChainScript
    function scriptChunkCount() external view returns (uint256) {
        _delegateCodeRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxOnChainScript
    function scriptChunk(uint256 /* index */ ) external view returns (bytes memory) {
        _delegateCodeRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxOnChainScript
    function scriptLocked() external view returns (bool) {
        _delegateCodeRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @dev Enable the extension (announce version). Call at initialize.
    function _initOnChainScript() internal {
        _setExtensionVersion(ID, VERSION);
    }

    /// @notice ERC-165: the core base (165 + beacon) + this extension's read interface.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbxBeaconCore)
        returns (bool)
    {
        return AbxBeaconCore.supportsInterface(interfaceId)
            || interfaceId == type(IAbxOnChainScript).interfaceId;
    }
}
