// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {IAbxOnChainMetadata} from "../extensions/onchain-metadata/IAbxOnChainMetadata.sol";
import {OnChainMetadataStorage} from "./OnChainMetadataStorage.sol";

/// @title AbxMetadataLib — the on-chain metadata field store's write + read paths, as an EXTERNAL
///        library
/// @notice The sibling of {AbxParamsLib} / {AbxCodeLib} / {AbxEditionLib}, and the first one every
///         token type links: {OnChainMetadata} is composed by ALL SIX deployable tokens, so its
///         bodies were the largest block of code inlined six times over. Externalizing them buys
///         EIP-170 headroom everywhere at once, which is what the 2026-08-14 independent audit asked
///         for before any further remediation was stacked onto contracts sitting at 187 and 249
///         bytes of margin.
///
/// @dev Delegatecalled, so every storage write lands in the TOKEN's own ERC-7201 namespace and every
///      event logs from the token address — the spine is byte-identical to the inlined version this
///      replaces.
///
///      **One implementation, by construction.** The mixin does not keep a copy: its externals are
///      thin `onlyOwner` shells that call in here, and its reads are a raw-calldata passthrough.
///      That shape is deliberate. The pattern this repo previously used — a mixin body plus a
///      library copy, with concrete tokens overriding to pick the library — produced three separate
///      bugs where a fix landed in the copy that does not run. There is nothing here to drift
///      against.
///
///      **Reads pass raw calldata rather than re-encoding.** A typed Solidity shell
///      (`return AbxMetadataLib.f(...)`) GREW the caller by ~855 B when it was tried on the params
///      surface, because decoding and re-encoding a dynamic return at the call site costs more than
///      the extracted body saves. The passthrough forwards the calldata untouched and returns the
///      library's returndata untouched, so the token pays one dispatch entry per selector and
///      nothing else.
library AbxMetadataLib {
    // ── event + error mirrors (identical signatures ⇒ identical topics/selectors) ───────────────
    event TokenFieldSet(uint256 indexed tokenId, bytes32 indexed field, bytes32 representation, bytes value);
    event ContractFieldSet(bytes32 indexed field, bytes32 representation, bytes value);
    event TokenFieldLocked(uint256 indexed tokenId, bytes32 indexed field);
    event ContractFieldLocked(bytes32 indexed field);
    event MetadataUpdate(uint256 _tokenId); // ERC-4906
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId); // ERC-4906
    event ContractURIUpdated(); // ERC-7572

    error FieldLocked();
    error EmptyFieldValue();

    // ── token scope ────────────────────────────────────────────────────────────────────────────

    function setTokenField(
        uint256 tokenId,
        bytes32 field,
        bytes32 representation,
        bytes calldata value
    ) public {
        _setTokenField(tokenId, field, representation, value);
        emit MetadataUpdate(tokenId); // ERC-4906: exactly the one token that changed
    }

    /// @dev No refresh ping: a lock changes what may CHANGE, never what currently resolves.
    function lockTokenField(uint256 tokenId, bytes32 field) public {
        OnChainMetadataStorage.layout().tokenLocked[tokenId][field] = true;
        emit TokenFieldLocked(tokenId, field);
    }

    function tokenField(uint256 tokenId, bytes32 field)
        public
        view
        returns (bytes32 representation, bytes memory value)
    {
        OnChainMetadataStorage.Field storage f =
            OnChainMetadataStorage.layout().tokenFields[tokenId][field];
        return (f.representation, f.value);
    }

    function tokenFieldLocked(uint256 tokenId, bytes32 field) public view returns (bool) {
        return OnChainMetadataStorage.layout().tokenLocked[tokenId][field];
    }

    // ── collection scope ───────────────────────────────────────────────────────────────────────

    function setContractField(bytes32 field, bytes32 representation, bytes calldata value) public {
        _setContractField(field, representation, value);
        // The range form belongs HERE and only here: a collection-scope field is the fallback for
        // every token (the renderer resolves token scope first, collection second), so one write
        // genuinely moves the whole collection's document.
        emit BatchMetadataUpdate(0, type(uint256).max);
        // A collection field is also an input to the COLLECTION document — the renderer reads seven
        // of them, `creator` and `license` among them — so this write moves `contractURI()` too and
        // owes ERC-7572 its signal.
        emit ContractURIUpdated();
    }

    function lockContractField(bytes32 field) public {
        OnChainMetadataStorage.layout().contractLocked[field] = true;
        emit ContractFieldLocked(field);
    }

    function contractField(bytes32 field)
        public
        view
        returns (bytes32 representation, bytes memory value)
    {
        OnChainMetadataStorage.Field storage f =
            OnChainMetadataStorage.layout().contractFields[field];
        return (f.representation, f.value);
    }

    function contractFieldLocked(bytes32 field) public view returns (bool) {
        return OnChainMetadataStorage.layout().contractLocked[field];
    }

    // ── init ───────────────────────────────────────────────────────────────────────────────────

    /// @dev Both init forms are ONE delegatecall each, not one per field: the loops live here.
    ///      A per-field hop would have made a Series seeding many slots pay a dispatch per field.
    function initFields(
        uint256 tokenId,
        IAbxOnChainMetadata.FieldInput[] calldata tokenFields,
        IAbxOnChainMetadata.FieldInput[] calldata contractFields
    ) public {
        for (uint256 i; i < tokenFields.length; ++i) {
            _setTokenField(
                tokenId, tokenFields[i].field, tokenFields[i].representation, tokenFields[i].value
            );
        }
        for (uint256 i; i < contractFields.length; ++i) {
            _setContractField(
                contractFields[i].field, contractFields[i].representation, contractFields[i].value
            );
        }
    }

    /// @dev The multi-token form: each entry carries its own token id (a Series seeding per-slot
    ///      fields at deploy).
    function initFieldsMulti(
        IAbxOnChainMetadata.TokenFieldInput[] calldata tokenFields,
        IAbxOnChainMetadata.FieldInput[] calldata contractFields
    ) public {
        for (uint256 i; i < tokenFields.length; ++i) {
            _setTokenField(
                tokenFields[i].tokenId,
                tokenFields[i].field,
                tokenFields[i].representation,
                tokenFields[i].value
            );
        }
        for (uint256 i; i < contractFields.length; ++i) {
            _setContractField(
                contractFields[i].field, contractFields[i].representation, contractFields[i].value
            );
        }
    }

    // ── internals ──────────────────────────────────────────────────────────────────────────────

    function _setTokenField(
        uint256 tokenId,
        bytes32 field,
        bytes32 representation,
        bytes calldata value
    ) private {
        OnChainMetadataStorage.Layout storage l = OnChainMetadataStorage.layout();
        if (l.tokenLocked[tokenId][field]) revert FieldLocked();
        if (value.length == 0) revert EmptyFieldValue();
        OnChainMetadataStorage.Field storage f = l.tokenFields[tokenId][field];
        f.representation = representation;
        f.value = value;
        emit TokenFieldSet(tokenId, field, representation, value);
    }

    function _setContractField(bytes32 field, bytes32 representation, bytes calldata value) private {
        OnChainMetadataStorage.Layout storage l = OnChainMetadataStorage.layout();
        if (l.contractLocked[field]) revert FieldLocked();
        if (value.length == 0) revert EmptyFieldValue();
        OnChainMetadataStorage.Field storage f = l.contractFields[field];
        f.representation = representation;
        f.value = value;
        emit ContractFieldSet(field, representation, value);
    }
}
