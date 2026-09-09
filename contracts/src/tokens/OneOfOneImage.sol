// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {ERC721} from "solady/tokens/ERC721.sol";

import {AbxErc721Base} from "../core/AbxErc721Base.sol";
import {TokenURI} from "../uri/token/TokenURI.sol";
import {ContractURI} from "../uri/contract/ContractURI.sol";
import {RoyaltyExtension} from "../extensions/royalty/RoyaltyExtension.sol";
import {CreatorToken} from "../extensions/creator-token/CreatorToken.sol";
import {OnChainMetadata} from "../extensions/onchain-metadata/OnChainMetadata.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {IAbxOnChainMetadata} from "../extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @title OneOfOneImage — a single 1/1 image NFT
/// @notice The simplest self-hostable ABX token, assembled by composition: core
///         (`AbxErc721Base`) + the `TokenURI` and `ContractURI` strategies + the
///         `RoyaltyExtension` + the `OnChainMetadata` extension. One contract = one
///         work = one token (id 0). `tokenURI`/`contractURI` resolve off-chain by
///         default (a stored pointer), or fully on-chain when a renderer is configured —
///         the `OnChainMetadata` store holds the fields, an `IAbxMetadataRenderer`
///         assembles them, and the renderer pointer is the toggle. Deployed as an
///         immutable EIP-1167 clone by {OneOfOneImageFactory}; never used directly.
contract OneOfOneImage is
    AbxErc721Base,
    TokenURI,
    ContractURI,
    OnChainMetadata,
    RoyaltyExtension,
    CreatorToken
{
    /// @notice The single token's id.
    uint256 internal constant TOKEN_ID = 0;

    /// @param owner Initial owner (creator); holds all admin rights.
    /// @param mintTo Recipient of the single token at deploy. `address(0)` defers
    ///        the mint — deploy the contract (and warm a resolver at its known
    ///        address) first, then {mint} when ready, or mint to a buyer on sale.
    /// @param name ERC-721 collection name.
    /// @param symbol ERC-721 collection symbol.
    /// @param tokenURIBase Off-chain resolver base for the token URI (used when tokenURIRenderer
    ///        is 0); the per-token pointer is derived on-chain as `{base}/{chainId}/{address}/{tokenId}`.
    /// @param tokenURIRenderer On-chain renderer for the token URI; `address(0)` = resolve
    ///        off-chain via the base. Non-zero = assemble the JSON on-chain from the fields.
    /// @param contractURIBase Off-chain resolver base for the collection (used when
    ///        contractURIRenderer is 0); derived on-chain as `{base}/{chainId}/{address}`.
    /// @param contractURIRenderer On-chain renderer for the collection URI; `address(0)` = off-chain.
    /// @param royaltyReceiver Default royalty payee.
    /// @param royaltyBps Default royalty in basis points (<= maxRoyaltyBps).
    /// @param maxRoyaltyBps Royalty ceiling in basis points (0–10000). Owner-set at deploy and
    ///        reduce-only after; tooling defaults it to 1000 (10%).
    /// @param burnable Opt-in burn (default false). When true, holders (or approved operators) may
    ///        {burn} their token; when false the token can never be destroyed.
    /// @param transferValidator Zero = a plain ERC-721 forever (the default). Non-zero =
    ///        permanently enrolled as an ERC-721C creator token with this validator (the owner
    ///        may re-point or suspend it later, never un-enroll).
    /// @param tokenFields Optional on-chain metadata fields for token 0 (each field → one representation).
    /// @param contractFields Optional on-chain metadata fields for the collection.
    struct InitParams {
        address owner;
        address mintTo; // address(0) = don't mint at deploy
        string name;
        string symbol;
        string tokenURIBase;
        address tokenURIRenderer; // address(0) = off-chain (derive from tokenURIBase); else on-chain
        string contractURIBase;
        address contractURIRenderer; // address(0) = off-chain (derive from contractURIBase); else on-chain
        address royaltyReceiver;
        uint16 royaltyBps;
        uint16 maxRoyaltyBps; // royalty ceiling (bps, 0–10000); reduce-only after deploy
        bool burnable; // opt-in burn; false = tokens can never be destroyed
        address transferValidator; // address(0) = plain ERC-721; else permanent 721C enrollment
        IAbxOnChainMetadata.FieldInput[] tokenFields; // optional; empty = none on-chain
        IAbxOnChainMetadata.FieldInput[] contractFields; // optional; empty = none on-chain
    }

    constructor() {
        // Lock the implementation: only clones (which start uninitialized) can initialize.
        _disableInitializers();
    }

    /// @notice One-time setup, called by the factory in the deploy transaction.
    /// @dev Event order: AbxDeployed → AbxExtensionVersionSet(royalty) → MaxRoyaltyBpsUpdated →
    ///      RoyaltyChangedForAll → BurnConfigured → ContractURIUpdated
    ///      → [AbxExtensionVersionSet(creator-token) → TransferValidatorUpdated] → (if minting) Transfer(0x0, mintTo, 0). (Ownable's
    ///      OwnershipTransferred precedes them, during owner init.) When `mintTo` is
    ///      zero the token is minted later via {mint}, so no Transfer fires here.
    function initialize(InitParams calldata p) external initializer {
        _initOwner(p.owner);

        // stored values, no events: token-URI strategy + ERC-721 collection identity
        _initTokenURI(p.tokenURIBase, p.tokenURIRenderer);
        _initCollectionMetadata(p.name, p.symbol);

        // discovery beacon → extensions (royalty, burn, creator-token, on-chain metadata) →
        // contract-URI strategy.
        // Order: AbxDeployed → AbxExtensionVersionSet(royalty) → MaxRoyaltyBpsUpdated →
        // RoyaltyChangedForAll → BurnConfigured → AbxExtensionVersionSet(onchain-metadata) →
        // TokenFieldSet*/ContractFieldSet* → ContractURIUpdated →
        // [AbxExtensionVersionSet(creator-token) → TransferValidatorUpdated].
        _emitAbxDeployed();
        _initRoyaltyExtension(p.royaltyReceiver, p.royaltyBps, p.maxRoyaltyBps);
        _initBurn(p.burnable);
        _initOnChainMetadata(TOKEN_ID, p.tokenFields, p.contractFields);
        _initContractURI(p.contractURIBase, p.contractURIRenderer);

        // LAST, because it is the only external call in this function. `_initCreatorToken` calls
        // the owner-supplied validator (`_requireHasCode`, then `setTokenTypeOfCollection`), so a
        // validator that is also the owner's own contract gets a reentrancy window into a
        // half-initialized clone. Every cap and guard must already be written when that window
        // opens: with this call earlier, `OneOfOneEdition` was reachable with `totalSupply(0) >
        // maxSupply(0)` — `_initEditionSupply` had not run, so `defaultCap == 0` still read as
        // "open edition, no check" — and the resulting state was frozen, since `setMaxSupply`
        // then refuses in both directions. The other five tokens were only accidentally safe
        // (`maxInvocations == 0` reads the same way in that window). Ordering, not accident.
        _initCreatorToken(p.transferValidator);

        // mint the single token now, or defer it (mintTo == 0) to a later {mint}.
        // Transfer from 0x0 is the ERC-721 "mint" signal either way.
        if (p.mintTo != address(0)) _mint(p.mintTo, TOKEN_ID);
    }

    /// @notice Mint the single token (id 0) to `to`. Owner-only and one-shot: it
    ///         reverts once the token exists, so the 1/1 can never become a 1/2.
    /// @dev Lets a creator deploy first — standing up and warming the resolver at
    ///      the contract's (deterministic) address before any marketplace sees a
    ///      mint — then issue the token, or mint straight to a buyer on a primary
    ///      sale. Emits Transfer(0x0, to, 0), the ERC-721 mint signal the indexer
    ///      folds into ownership.
    function mint(address to) external onlyOwner {
        _mint(to, TOKEN_ID);
    }

    /// @dev Compose ERC-165 by OR-ing the base and each mixin that defines supportsInterface.
    ///      (ContractURI defines none — ERC-7572 has no 165 id — so it's absent here.)
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AbxErc721Base, TokenURI, OnChainMetadata, RoyaltyExtension, CreatorToken)
        returns (bool)
    {
        return AbxErc721Base.supportsInterface(interfaceId)
            || TokenURI.supportsInterface(interfaceId)
            || OnChainMetadata.supportsInterface(interfaceId)
            || RoyaltyExtension.supportsInterface(interfaceId)
            || CreatorToken.supportsInterface(interfaceId);
    }

    /// @dev Creator-token wiring: when enrolled with a live validator, every real transfer
    ///      (never a mint/burn) must pass the validator's policy check before moving.
    function _beforeTokenTransfer(address from, address to, uint256 id)
        internal
        override(ERC721)
    {
        super._beforeTokenTransfer(from, to, id);
        _validateTransfer(from, to, id);
    }

    /// @dev Diamond disambiguation only — the live-supply counter lives in {AbxErc721Base}
    ///      (base level); `super` routes the mint/burn hook there via C3 linearization.
    function _afterTokenTransfer(address from, address to, uint256 id)
        internal
        override(AbxErc721Base, ERC721)
    {
        super._afterTokenTransfer(from, to, id);
    }
}
