// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {AbxBeaconCore} from "../../core/AbxBeaconCore.sol";
import {IAbxOnChainMetadata} from "./IAbxOnChainMetadata.sol";
import {IERC4906} from "../../interfaces/IERC4906.sol";
import {IERC7572} from "../../interfaces/IERC7572.sol";
import {AbxMetadataLib} from "../../libraries/AbxMetadataLib.sol";
import {OnChainMetadataStorage} from "../../libraries/OnChainMetadataStorage.sol";

/// @title OnChainMetadata — the ABX On-Chain Metadata extension (Register 2), as a mixin
/// @notice A token opts in by inheriting this. Each `field` (image, description, …) holds ONE
///         active `{representation, value}` at per-token and contract-wide (collection) scopes —
///         so any field can optionally live on-chain (`inline`), be located off-chain
///         (`arweave`/`ipfs`/`url`/custody via `keccak256`), or be read+decoded by a separate
///         on-chain `reader`. Owner-settable; freezable per `(scope, field)`.
/// @dev Read surface → non-zero ERC-165 id (advertised in addition to the beacon's
///      `extensionVersion`). Storage is ERC-7201 (`OnChainMetadataStorage`). The `bytes32` keys
///      are opaque here — field and representation meaning plus the resolution rules are protocol
///      convention, never baked into the contract. The
///      store NEVER decodes; on-chain decoding is delegated to an `IAbxOnChainReader` referenced
///      from a `"reader"` field's value. Token existence is not enforced (owner-gated).
/// @dev **Refresh signals.** Every write below changes what `tokenURI`/`uri(id)` resolves to, so
///      each emits ERC-4906 — the ping marketplaces and indexers honour. This surface used to
///      mutate silently, which meant a correctly-behaving indexer that refreshes on ERC-4906 and
///      otherwise trusts its cache served the pre-edit document indefinitely: for a protocol whose
///      claim is that the metadata lives on chain, the difference between a promise and a working
///      system.
///
///      A token-scope write emits the PER-TOKEN `MetadataUpdate(tokenId)`; only a collection-scope
///      write emits the collection-wide `BatchMetadataUpdate(0, max)`, because only that one actually
///      moves every token. These were briefly collapsed into the range form for both to save two
///      event-topic constants (~138 B) on the two code tokens, which was the wrong trade: it asked
///      an indexer to refresh a 10,000-token series because one token's field changed, and that is
///      exactly the shape marketplaces throttle or ignore. The bytes came back from a library
///      extraction instead.
///
///      The events are emitted on BOTH standards and the 1155 lane advertises
///      `0x49064906` alongside its native `URI`. ERC-4906 is nominally a 721 extension, but the
///      range form is what the ecosystem actually consumes for 1155 too — OpenSea's own
///      `ERC1155SeaDrop` emits `BatchMetadataUpdate(0, type(uint256).max)` on an ERC-1155 — and the
///      4906 interface id is a bespoke constant rather than a selector XOR, so advertising it is a
///      metadata-refresh marker and not a claim of ERC-721 support. Emitting one event both lanes
///      understand beat a per-lane virtual hook that would have cost bytecode on all six tokens.
///
///      Emitted from the EXTERNAL setters only. The `_set*` internals are also used by
///      `initialize`, where a refresh ping is noise (nothing has indexed the collection yet) and
///      would change the documented deploy event order.
abstract contract OnChainMetadata is AbxBeaconCore, Ownable, IAbxOnChainMetadata, IERC4906, IERC7572 {
    /// @dev keccak256("abx.extension.onchain-metadata") — permanent extension id. `private`
    ///      so it never collides with another extension's `ID` in a composing token.
    bytes32 private constant ID =
        0x2bdf776d17261ce184defba0b7b3e2cccd288be7cdbe6f7081cb993f3327f71c;

    /// @dev Current implemented version (bumps when this interface or semantics change).
    uint16 private constant VERSION = 1;

    // FieldInput / TokenFieldInput are declared on IAbxOnChainMetadata (see there for why) and
    // remain reachable as `IAbxOnChainMetadata.FieldInput` through inheritance.

    error FieldLocked();
    error EmptyFieldValue();

    // ── token scope ───────────────────────────────────────────────────────────

    /// @notice Owner sets/replaces a token field's active representation + value.
    function setTokenField(
        uint256 tokenId,
        bytes32 field,
        bytes32 representation,
        bytes calldata value
    ) external onlyOwner {
        AbxMetadataLib.setTokenField(tokenId, field, representation, value);
    }

    /// @notice Owner freezes a token `field` forever.
    /// @dev No refresh ping: a lock changes what may CHANGE, never what currently resolves.
    function lockTokenField(uint256 tokenId, bytes32 field) external onlyOwner {
        AbxMetadataLib.lockTokenField(tokenId, field);
    }

    /// @inheritdoc IAbxOnChainMetadata
    function tokenField(uint256 tokenId, bytes32 field)
        external
        view
        returns (bytes32 representation, bytes memory value)
    {
        _delegateMetadataRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxOnChainMetadata
    function tokenFieldLocked(uint256 tokenId, bytes32 field) external view returns (bool) {
        _delegateMetadataRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    // ── collection scope ────────────────────────────────────────────────────--

    /// @notice Owner sets/replaces a collection (contract-wide) field's representation + value.
    function setContractField(bytes32 field, bytes32 representation, bytes calldata value)
        external
        onlyOwner
    {
        AbxMetadataLib.setContractField(field, representation, value);
    }

    /// @notice Owner freezes a collection `field` forever.
    function lockContractField(bytes32 field) external onlyOwner {
        AbxMetadataLib.lockContractField(field);
    }

    /// @inheritdoc IAbxOnChainMetadata
    function contractField(bytes32 field)
        external
        view
        returns (bytes32 representation, bytes memory value)
    {
        _delegateMetadataRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    /// @inheritdoc IAbxOnChainMetadata
    function contractFieldLocked(bytes32 field) external view returns (bool) {
        _delegateMetadataRead();
        revert(); // unreachable — the passthrough always `return`s or `revert`s the frame
    }

    // ── init ────────────────────────────────────────────────────────────────--

    /// @dev Enable the extension (announce version) + set any initial fields for ONE token id.
    ///      The single-token form used by a 1/1. Call at initialize.
    function _initOnChainMetadata(
        uint256 tokenId,
        FieldInput[] calldata tokenFields,
        FieldInput[] calldata contractFields
    ) internal {
        _enableOnChainMetadata();
        AbxMetadataLib.initFields(tokenId, tokenFields, contractFields);
    }

    /// @dev Enable the extension (announce version) + set initial fields across MANY token ids —
    ///      each `TokenFieldInput` carries its own token id. The multi-token form used by a
    ///      Series to seed per-slot fields. Call at initialize.
    function _initOnChainMetadataMulti(
        TokenFieldInput[] calldata tokenFields,
        FieldInput[] calldata contractFields
    ) internal {
        _enableOnChainMetadata();
        AbxMetadataLib.initFieldsMulti(tokenFields, contractFields);
    }

    /// @dev Announce the extension version. Shared by both init forms (single- and multi-token).
    function _enableOnChainMetadata() private {
        _setExtensionVersion(ID, VERSION);
    }

    // ── internals ─────────────────────────────────────────────────────────────

    /// @dev Forward this read's raw calldata to {AbxMetadataLib} and return its returndata
    ///      untouched. Same shape and same reason as {Params-_delegateParamsRead}: a typed shell
    ///      that decodes and re-encodes a dynamic return costs more than the extracted body saves.
    function _delegateMetadataRead() private view {
        function() internal fn = _delegateMetadataReadRaw;
        function() internal view viewFn;
        assembly {
            viewFn := fn
        }
        viewFn();
    }

    /// @dev The raw forward. Non-view only because assembly `delegatecall` is always flagged.
    function _delegateMetadataReadRaw() private {
        address lib = address(AbxMetadataLib);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), lib, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
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
            || interfaceId == type(IAbxOnChainMetadata).interfaceId
            // ERC-4906. Advertised HERE, from the mixin that emits it, so the answer is the same on
            // both standards and cannot drift from the emissions — the 1155 lane previously emitted
            // 4906 (via the shared param library) while advertising nothing, which is the exact
            // mismatch an indexer cannot recover from. The id is a bespoke constant from the EIP,
            // not a selector XOR, so it carries no implied ERC-721 support. ERC-7572 has no id to
            // advertise; `ContractURIUpdated` is its only signal.
            || interfaceId == 0x49064906;
    }
}
