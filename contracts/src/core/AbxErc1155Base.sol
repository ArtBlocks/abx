// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {ERC1155} from "solady/tokens/ERC1155.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {Initializable} from "solady/utils/Initializable.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";

import {AbxBeaconCore} from "./AbxBeaconCore.sol";
import {CollectionMetadataLib} from "../libraries/CollectionMetadataLib.sol";
import {Erc1155SupplyStorage} from "../libraries/Erc1155SupplyStorage.sol";

/// @title AbxErc1155Base — core ABX ERC-1155 token (no URI strategies, no extensions baked in)
/// @notice The ERC-1155 sibling of `AbxErc721Base`: a Solady ERC-1155 + the AbxBeaconCore (beacon
///         + versioning) + Ownable + Initializable + collection identity (`name`/`symbol`,
///         reusing `CollectionMetadataLib` unchanged — ERC-1155 has no standard `name`/`symbol`,
///         but keeping them lets the renderer and marketplaces work identically to the 721
///         twins). A concrete edition token composes this with a **token-URI strategy**
///         (`Uri1155`), a **contract-URI strategy** (`ContractURI` — reused as-is, it has no
///         ERC-721 coupling), and any opt-in **extensions** — so it carries only what it needs
///         and ERC-165 reflects exactly that.
/// @dev **The gated-hooks footgun (Solady ERC1155-specific; absent from Solady ERC721).**
///      `_beforeTokenTransfer`/`_afterTokenTransfer` are always batch-shaped
///      (`uint256[] ids, uint256[] amounts`; a single transfer wraps scalars into 1-element
///      arrays) AND gated by `_useBeforeTokenTransfer()`/`_useAfterTokenTransfer()` (default
///      `false` — silently dead code if you override a hook without also overriding its gate).
///      This base overrides BOTH gates to `true` unconditionally: the after-hook is needed here
///      for per-id supply bookkeeping; the before-hook has no base-level logic (Solady's empty
///      default stands unoverridden here) but must still be "on" so a composing token's own
///      `_beforeTokenTransfer` override (e.g. `CreatorToken1155` wiring) actually runs — exactly
///      mirroring how the 721 base leaves `_beforeTokenTransfer` unoverridden and lets the
///      concrete token layer creator-token validation on top via `super`.
///
///      Per-id supply lives in `Erc1155SupplyStorage` — a freestanding ERC-7201 library, not a
///      base-owned public getter: this base maintains the counter unconditionally (every 1155
///      token, mirroring `SupplyStorage`'s core-level role for 721), but the PUBLIC
///      `totalSupply(id)`/`exists(id)` reads belong to the opt-in `EditionSupply` extension
///      (`specs/protocol/interfaces.md` attributes them to "the Edition Supply extension's read
///      surface", unlike 721's unconditional `totalSupply()`). Any mixin — the extension, or a
///      composing token's own id-space floor — reads the same library directly; no inheritance
///      coupling between the base and the extension is needed for a plain library.
///
///      Batching: every ABX token is `Multicallable` (see `AbxErc721Base` for the full
///      security-invariant writeup — identical here: `delegatecall`-to-self preserves
///      `msg.sender`, so no authority amplification; atomic; no `msg.value` double-spend; never
///      combined with ERC-2771).
abstract contract AbxErc1155Base is ERC1155, AbxBeaconCore, Ownable, Initializable, Multicallable {

    /// @notice A collection cannot be created without an owner.
    error InvalidOwner();

    /// @notice This collection did not opt into burning at deploy, so no copy can be destroyed.
    error BurnDisabled();

    /// @notice Whether this collection enabled burning, set once at deploy. Emitted so an indexer
    ///         can serve it from the log with no call.
    event BurnConfigured(bool burnable);

    /// @notice Whether this collection allows copies to be burned (opt-in at deploy, default off).
    ///         Fixed after init — a project's burnability is a property a buyer can rely on.
    function burnable() public view returns (bool) {
        return Erc1155SupplyStorage.layout().burnable;
    }

    /// @dev Record the opt-in burn choice + announce it. Call at initialize.
    function _initBurn(bool burnable_) internal {
        Erc1155SupplyStorage.layout().burnable = burnable_;
        emit BurnConfigured(burnable_);
    }

    /// @notice Burn `amount` of token `id` held by `from`. Reverts unless the collection opted into
    ///         burning; otherwise standard ERC-1155 authorization applies (caller must be `from` or
    ///         an approved operator — Solady's `_burn(by, from, id, amount)` enforces it). A burn is
    ///         a `TransferSingle(op, from, 0x0, id, amount)`, so per-id `totalSupply` decrements and
    ///         any wired param transfer hook fires on the move (burn-to-combine rides that hook).
    /// @dev Routes through `_burn(msg.sender, from, id, amount)` so operator approval is checked;
    ///      there is no owner bypass.
    function burn(address from, uint256 id, uint256 amount) external {
        if (!Erc1155SupplyStorage.layout().burnable) revert BurnDisabled();
        _burn(msg.sender, from, id, amount);
    }

    /// @dev Initialize ownership, refusing `address(0)`. A zero owner is not "an immutable
    ///      collection" — it is a collection whose every owner-only operation is unreachable from
    ///      birth. Combined with a live transfer validator and a deploy-time mint it produced, in
    ///      ONE transaction, a collection that already held collectors' tokens, already enforced a
    ///      transfer policy, and had nobody who could ever suspend it. Renouncing later is still
    ///      permitted — on an enrolled creator token that is safe because suspension becomes
    ///      permissionless once `owner() == address(0)` (see
    ///      {CreatorToken-_requireValidatorAuth}), so an abandoned collection can always be moved
    ///      back toward transferability. This refuses only *starting* ownerless, which no
    ///      legitimate deploy needs and which no later recovery can undo.
    function _initOwner(address owner_) internal {
        if (owner_ == address(0)) revert InvalidOwner();
        _initializeOwner(owner_);
    }

    function name() public view returns (string memory) {
        return CollectionMetadataLib.layout().name;
    }

    function symbol() public view returns (string memory) {
        return CollectionMetadataLib.layout().symbol;
    }

    /// @dev Set the collection identity at initialize. No event (set once at mint).
    function _initCollectionMetadata(string calldata name_, string calldata symbol_) internal {
        CollectionMetadataLib.Layout storage m = CollectionMetadataLib.layout();
        m.name = name_;
        m.symbol = symbol_;
    }

    /// @dev Turn the before-hook "on" so a composing token's own override (creator-token
    ///      validation) actually runs. No logic here — see the class-level dev note.
    function _useBeforeTokenTransfer() internal view virtual override returns (bool) {
        return true;
    }

    /// @dev Turn the after-hook "on" — required unconditionally for the per-id supply counter.
    function _useAfterTokenTransfer() internal view virtual override returns (bool) {
        return true;
    }

    /// @dev Maintain the per-id live-count counter on every mint/burn. Solady's hook is always
    ///      batch-shaped (single ops wrap into 1-element arrays); loop and sum. A transfer
    ///      between two non-zero holders changes no id's total supply, so there is nothing to do
    ///      in that case — the early `if`/`else if` skips the loop entirely.
    function _afterTokenTransfer(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) internal virtual override {
        if (from == address(0)) {
            Erc1155SupplyStorage.Layout storage l = Erc1155SupplyStorage.layout();
            for (uint256 i; i < ids.length; ++i) {
                l.totalSupply[ids[i]] += amounts[i];
            }
        } else if (to == address(0)) {
            Erc1155SupplyStorage.Layout storage l = Erc1155SupplyStorage.layout();
            for (uint256 i; i < ids.length; ++i) {
                l.totalSupply[ids[i]] -= amounts[i];
            }
        }
        super._afterTokenTransfer(from, to, ids, amounts, data);
    }

    /// @notice ERC-165: core (165 + beacon, via AbxBeaconCore) + ERC-1155 (+ MetadataURI).
    ///         Token-URI strategies and extensions OR in their own ids in the concrete token.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC1155, AbxBeaconCore)
        returns (bool)
    {
        return AbxBeaconCore.supportsInterface(interfaceId) // 165 + beacon
            || ERC1155.supportsInterface(interfaceId); // 1155 + 1155MetadataURI
    }

}
