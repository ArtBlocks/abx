// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {ERC721} from "solady/tokens/ERC721.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {Initializable} from "solady/utils/Initializable.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";

import {AbxBeaconCore} from "./AbxBeaconCore.sol";
import {CollectionMetadataLib} from "../libraries/CollectionMetadataLib.sol";
import {SupplyStorage} from "../libraries/SupplyStorage.sol";

/// @title AbxErc721Base — core ABX ERC-721 token (no URI strategies, no extensions baked in)
/// @notice The shared core every ABX token type builds on: a Solady ERC-721 + the
///         AbxBeaconCore (beacon + versioning) + Ownable + Initializable + ERC-721
///         collection identity (`name`/`symbol`). A concrete token composes this with a
///         **token-URI strategy** (e.g. `TokenURI`), a **contract-URI strategy**
///         (e.g. `ContractURI`), and any opt-in **extensions** (e.g.
///         `RoyaltyExtension`) — so it carries only what it needs and ERC-165 reflects
///         exactly that.
/// @dev Building blocks, deliberately distinct:
///      - **Interfaces** (IERC4906, IERC7572, IAbx*) — external ABI: events + 165 ids, no storage/logic.
///      - **Libraries** (TokenURIStorage, ContractURIStorage, CollectionMetadataLib) — ERC-7201 state.
///      - **URI strategies** (TokenURI / ContractURI, …) — mixins resolving a metadata URI (derived base pointer, per-token override, or on-chain renderer).
///      - **Extension mixins** (RoyaltyExtension) — an opt-in extension's events + identity + logic.
///
///      Batching: every ABX token is {Multicallable}, so an owner can apply several
///      owner ops (set fields, point a renderer, lock) in **one** atomic transaction —
///      `multicall` `delegatecall`s each call into this same contract, preserving
///      `msg.sender`, so each subcall re-runs its own `onlyOwner`/lock checks. The batch
///      is therefore exactly equivalent to sending each call individually from the same
///      sender (no authority amplification) and is all-or-nothing (any revert bubbles).
///      Solady's `multicall` reverts on non-zero `msg.value`; no ABX function uses
///      `msg.value` for accounting, so the classic multicall double-spend cannot arise.
///      Do NOT combine this with ERC-2771 / a trusted forwarder (calldata-suffix
///      spoofing); ABX authorization reads the real `msg.sender` only.
abstract contract AbxErc721Base is ERC721, AbxBeaconCore, Ownable, Initializable, Multicallable {
    /// @notice A collection cannot be created without an owner.
    error InvalidOwner();

    /// @notice This collection did not opt into burning at deploy, so no token can be destroyed.
    error BurnDisabled();

    /// @notice Whether this collection enabled burning, set once at deploy. A fixed, buyer-readable
    ///         property emitted so an indexer can serve it from the log with no call.
    event BurnConfigured(bool burnable);

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

    function name() public view override returns (string memory) {
        return CollectionMetadataLib.layout().name;
    }

    function symbol() public view override returns (string memory) {
        return CollectionMetadataLib.layout().symbol;
    }

    /// @dev Set the ERC-721 collection identity at initialize. No event (set once at mint).
    function _initCollectionMetadata(string calldata name_, string calldata symbol_) internal {
        CollectionMetadataLib.Layout storage m = CollectionMetadataLib.layout();
        m.name = name_;
        m.symbol = symbol_;
    }

    /// @notice Whether this collection allows tokens to be burned (opt-in at deploy, default off).
    ///         Fixed after init — a project's burnability is a property a buyer can rely on.
    function burnable() public view returns (bool) {
        return SupplyStorage.layout().burnable;
    }

    /// @dev Record the opt-in burn choice + announce it. Call at initialize.
    function _initBurn(bool burnable_) internal {
        SupplyStorage.layout().burnable = burnable_;
        emit BurnConfigured(burnable_);
    }

    /// @notice Destroy token `id`. Reverts unless the collection opted into burning; otherwise the
    ///         standard ERC-721 authorization applies (caller must be the owner or an approved
    ///         operator — Solady's `_burn(by, id)` enforces it). A burn is a `Transfer(owner, 0x0,
    ///         id)`, so `totalSupply` decrements, `_exists` flips false (`tokenURI` then reverts),
    ///         and any wired param transfer hook fires on the move — burn-to-combine and breeding
    ///         ride that hook. The 721C transfer validator deliberately never sees a burn.
    /// @dev Routes through `_burn(msg.sender, id)` so approval is checked; there is no owner bypass —
    ///      even the collection owner must hold or be approved for the specific token.
    function burn(uint256 id) external {
        if (!SupplyStorage.layout().burnable) revert BurnDisabled();
        _burn(msg.sender, id);
    }

    /// @notice The number of tokens that exist right now (minted − burned). The
    ///         ERC-721-ecosystem read explorers/marketplaces use for "supply" — the *live
    ///         count*, distinct from any supply *cap* (the Max Invocations extension). This
    ///         contract intentionally does NOT implement full ERC-721 Enumerable
    ///         (`tokenByIndex`/`tokenOfOwnerByIndex` — gas-heavy, rarely consumed), so the
    ///         Enumerable interface id is deliberately NOT advertised in `supportsInterface`.
    function totalSupply() public view returns (uint256) {
        return SupplyStorage.layout().totalSupply;
    }

    /// @dev Maintain the live-count counter on every mint/burn. Solady calls this on mint
    ///      (`from == 0`), transfer (neither zero), and burn (`to == 0`).
    function _afterTokenTransfer(address from, address to, uint256 id) internal virtual override {
        if (from == address(0)) ++SupplyStorage.layout().totalSupply; // mint
        else if (to == address(0)) --SupplyStorage.layout().totalSupply; // burn
        super._afterTokenTransfer(from, to, id);
    }

    /// @notice ERC-165: core (165 + beacon, via AbxBeaconCore) + ERC-721.
    ///         Token-URI strategies and extensions OR in their own ids in the concrete token.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721, AbxBeaconCore)
        returns (bool)
    {
        return AbxBeaconCore.supportsInterface(interfaceId) // 165 + beacon
            || ERC721.supportsInterface(interfaceId); // 721 + 721Metadata
    }

}
