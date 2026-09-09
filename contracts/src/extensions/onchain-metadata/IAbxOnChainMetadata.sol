// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IAbxOnChainMetadata — On-Chain Metadata extension (Register 2)
/// @notice A generic on-chain metadata store: each `field` (the what: image/description/…)
///         holds ONE active `(representation, value)` — *how* it's carried (a protocol-
///         convention `bytes32` tag: "inline", "reader", "keccak256", "url", …) and the
///         payload — at per-token and contract-wide (collection) scopes, with a per-field
///         freeze. `value` rides each event, so the full set reconstructs from logs alone.
/// @dev The `bytes32` keys are opaque on-chain; field/representation meaning + the
///      resolution rules are protocol convention (`specs/protocol/onchain-metadata.md`), never
///      baked into the contract. On-chain decoding (e.g. decompression) is delegated to a separate
///      {IAbxOnChainReader} contract referenced from a field's `value` — see the "reader"
///      representation; the storage here never decodes anything.
interface IAbxOnChainMetadata {
    /// @notice A `(field, representation, value)` to set at initialize (single scope: one token
    ///         id, or the collection).
    /// @dev Declared on the INTERFACE rather than the mixin so {AbxMetadataLib} can name it without
    ///      importing the mixin that imports the library. Inherited types stay reachable through the
    ///      derived name, so every existing `IAbxOnChainMetadata.FieldInput` reference is unaffected.
    struct FieldInput {
        bytes32 field;
        bytes32 representation;
        bytes value;
    }

    /// @notice A `(tokenId, field, representation, value)` to set at initialize — the multi-token
    ///         form, carrying its own token id so one array can seed fields across many tokens
    ///         (a Series seeds its metadata-id slots this way). For a 1/1 the single-scope
    ///         `FieldInput` + `_initOnChainMetadata` is used instead.
    struct TokenFieldInput {
        uint256 tokenId;
        bytes32 field;
        bytes32 representation;
        bytes value;
    }

    event TokenFieldSet(
        uint256 indexed tokenId, bytes32 indexed field, bytes32 representation, bytes value
    );
    event TokenFieldLocked(uint256 indexed tokenId, bytes32 indexed field);
    event ContractFieldSet(bytes32 indexed field, bytes32 representation, bytes value);
    event ContractFieldLocked(bytes32 indexed field);

    /// @notice A token field's active representation + value (both empty if unset).
    function tokenField(uint256 tokenId, bytes32 field)
        external
        view
        returns (bytes32 representation, bytes memory value);

    /// @notice Whether a token's `field` is frozen.
    function tokenFieldLocked(uint256 tokenId, bytes32 field) external view returns (bool);

    /// @notice A collection field's active representation + value.
    function contractField(bytes32 field)
        external
        view
        returns (bytes32 representation, bytes memory value);

    /// @notice Whether a collection `field` is frozen.
    function contractFieldLocked(bytes32 field) external view returns (bool);
}
