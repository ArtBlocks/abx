// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxParams — Params extension vocabulary (Register 2)
/// @notice On-chain metadata as `key → bytes` at two scopes (contract-wide and per-token).
///         `value` is one `bytes32`, and **`valueIsHash` tells the indexer how to read it**:
///         `false` → the literal; `true` → the keccak256 of the full value, read back via the
///         data view. A large value is **one blob, never multi-chunk** (bounded by the ~24 KB
///         SSTORE2 ceiling); content above that is a *pointer* param, not a bigger param.
///         Params hold **metadata, not behavior** — a capability belongs in its own extension.
///         Clearing is explicit: a value of `0` is a *valid value*; removing a key is its own
///         event, so "param is 0" and "param unset" never blur.
/// @notice Params are **enumerable on chain**: `tokenParamKeys` / `contractParamKeys` list a
///         scope's currently-set keys, so an on-chain consumer reads a token's whole param set
///         without knowing the keys in advance and without an indexer. Two rules bind consumers:
///         **order is unspecified** (insertion order, disturbed by removals — canonical
///         serialization sorts), and **`seed` is reserved and never listed** at either scope
///         (read it directly with `tokenParam(tokenId, "seed")`; it is a tokenData coordinate,
///         not an enumerated param). Everything else set is listed exactly once, and a cleared
///         key leaves.
/// @dev `updatedBy` (indexed) is the authorized actor who set the param — on-chain provenance
///      (can differ from the tx sender under delegation / hooks; under the Configurable Params
///      auth model, different actors set different params). Has a read surface → a real
///      ERC-165 id. Keys are readable-ASCII `bytes32` by convention (like fields).
interface IAbxParams {
    /// @notice A contract-scope param was set / changed.
    event ContractParamConfigured(
        bytes32 indexed key, bytes32 value, bool valueIsHash, address indexed updatedBy
    );

    /// @notice A token-scope param was set / changed.
    event TokenParamConfigured(
        uint256 indexed tokenId,
        bytes32 indexed key,
        bytes32 value,
        bool valueIsHash,
        address indexed updatedBy
    );

    /// @notice A contract-scope param was removed (distinct from being set to zero).
    event ContractParamCleared(bytes32 indexed key, address indexed updatedBy);

    /// @notice A token-scope param was removed (distinct from being set to zero).
    event TokenParamCleared(uint256 indexed tokenId, bytes32 indexed key, address indexed updatedBy);

    /// @notice A token param's active state. `isSet` distinguishes "0" from "unset".
    function tokenParam(uint256 tokenId, bytes32 key)
        external
        view
        returns (bytes32 value, bool valueIsHash, bool isSet);

    /// @notice A contract param's active state. `isSet` distinguishes "0" from "unset".
    function contractParam(bytes32 key)
        external
        view
        returns (bytes32 value, bool valueIsHash, bool isSet);

    /// @notice A large token-param's full content (empty bytes for literals / unset keys).
    ///         When set, `keccak256(returned bytes)` equals the evented `value`.
    function tokenParamData(uint256 tokenId, bytes32 key) external view returns (bytes memory);

    /// @notice A large contract-param's full content (empty bytes for literals / unset keys).
    function contractParamData(bytes32 key) external view returns (bytes memory);

    /// @notice Every token-scope key currently set for `tokenId`, `seed` excluded. Unspecified
    ///         order. The whole-set read an on-chain consumer makes in a single `eth_call`.
    function tokenParamKeys(uint256 tokenId) external view returns (bytes32[] memory);

    /// @notice A window on `tokenParamKeys` — the escape hatch past RPC response limits for a
    ///         project with many keys. Returns up to `count` keys from `start`, plus `total`
    ///         (the full list length); a `start` at or past the end returns empty, so a caller
    ///         can walk to exhaustion without a prior length read.
    function tokenParamKeysPaged(uint256 tokenId, uint256 start, uint256 count)
        external
        view
        returns (bytes32[] memory keys, uint256 total);

    /// @notice Every contract-scope key currently set, `seed` excluded. Unspecified order.
    function contractParamKeys() external view returns (bytes32[] memory);

    /// @notice A window on `contractParamKeys` — same semantics as `tokenParamKeysPaged`.
    function contractParamKeysPaged(uint256 start, uint256 count)
        external
        view
        returns (bytes32[] memory keys, uint256 total);
}
