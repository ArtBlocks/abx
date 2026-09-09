// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title OnChainScriptStorage — On-Chain Script extension state, ERC-7201 namespaced
/// @notice Backing storage for the On-Chain Script extension: the project's program as an
///         ordered list of SSTORE2 chunk pointers + the permanent lock flag. Chunks are too
///         large to log — `ScriptUpdated(index)` carries only the changed index; the content
///         reads back at head via `scriptChunk(index)`. Namespaced so it never collides with
///         the ERC-721 base or other mixins.
library OnChainScriptStorage {
    /// @custom:storage-location erc7201:abx.storage.onchain-script
    struct Layout {
        address[] chunks; // SSTORE2 data-contract pointers, in order
        bool locked; // true ⇒ the script is frozen permanently
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.onchain-script")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xe86835d06c8df9bb3fc01a89a0280acff46dcc2dd56a393c1fc527caf8d9c900;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
