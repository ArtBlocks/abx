// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {ERC721} from "solady/tokens/ERC721.sol";

import {AbxErc721Base} from "../core/AbxErc721Base.sol";
import {TokenURI} from "../uri/token/TokenURI.sol";
import {ContractURI} from "../uri/contract/ContractURI.sol";
import {RoyaltyExtension} from "../extensions/royalty/RoyaltyExtension.sol";
import {CreatorToken} from "../extensions/creator-token/CreatorToken.sol";
import {OnChainMetadata} from "../extensions/onchain-metadata/OnChainMetadata.sol";
import {MaxInvocations} from "../extensions/max-invocations/MaxInvocations.sol";
import {ExternalMinter} from "../extensions/external-minter/ExternalMinter.sol";
import {PrimaryPayee} from "../extensions/primary-payee/PrimaryPayee.sol";
import {Paused} from "../extensions/paused/Paused.sol";
import {IAbxSequentialMint} from "../interfaces/IAbxSequentialMint.sol";
import {SeriesMintStorage} from "../libraries/SeriesMintStorage.sol";
import {IAbxOnChainMetadata} from "../extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @title SeriesImage — a multi-token image/media Series NFT
/// @notice The multi-token sibling of {OneOfOneImage}, assembled by the same composition —
///         core (`AbxErc721Base`) + the `TokenURI`/`ContractURI` strategies + `RoyaltyExtension`
///         + `OnChainMetadata` — plus the extensions a sized drop needs: `MaxInvocations` (the
///         "X of Y" supply cap), `ExternalMinter` (delegate minting to a drop contract), and
///         `Paused` (a mint safety switch — owner-only while paused). `PrimaryPayee` declares
///         where primary-sale proceeds go. Deployed as an immutable EIP-1167 clone by
///         {SeriesImageFactory}; never used directly.
///
/// @dev **Token ids are strictly sequential** (`nextTokenId`, `0,1,2,…`) — the natural supply
///      count — and **a token's metadata is its token id**: token 3 shows the creator's metadata
///      for slot 3. There is no token-id ↔ metadata-id decoupling; the operational model is to
///      pre-mint the series and shuffle/sell tokens afterward, which keeps the contract, minting,
///      and indexing simple. Everything a 1/1 has works identically per token — cardinality is
///      not a type.
contract SeriesImage is
    AbxErc721Base,
    TokenURI,
    ContractURI,
    OnChainMetadata,
    RoyaltyExtension,
    CreatorToken,
    MaxInvocations,
    ExternalMinter,
    PrimaryPayee,
    Paused,
    IAbxSequentialMint
{
    /// @param owner Initial owner (creator); holds all admin rights.
    /// @param name ERC-721 collection name.
    /// @param symbol ERC-721 collection symbol.
    /// @param tokenURIBase Off-chain resolver base for token URIs (used when tokenURIRenderer is 0);
    ///        each token's pointer is derived on-chain as `{base}/{chainId}/{address}/{tokenId}`.
    /// @param tokenURIRenderer On-chain renderer; `address(0)` = resolve off-chain. Non-zero =
    ///        assemble JSON on-chain from the token's on-chain fields.
    /// @param contractURIBase Off-chain resolver base for the collection (used when contractURIRenderer is 0).
    /// @param contractURIRenderer On-chain renderer for the collection URI; `address(0)` = off-chain.
    /// @param royaltyReceiver Default royalty payee.
    /// @param royaltyBps Default royalty in basis points (<= the royalty cap).
    /// @param maxRoyaltyBps Royalty ceiling in basis points (0–10000), reduce-only after deploy.
    /// @param burnable Opt-in burn, fixed at deploy; `false` means tokens can never be destroyed.
    /// @param transferValidator Zero = a plain ERC-721 forever (the default). Non-zero =
    ///        permanently enrolled as an ERC-721C creator token with this validator (the owner
    ///        may re-point or suspend it later, never un-enroll).
    /// @param maxInvocations Series size N (> 0): the supply cap. Monotonically non-increasing
    ///        after deploy.
    /// @param primaryPayee Primary-sale payout destination (`address(0)` = none).
    /// @param minter Initial authorized minter — a single address (`address(0)` = owner-only).
    /// @param paused Initial mint-pause state — `true` restricts minting to the owner until
    ///        unpaused (deploy-time reserves still mint; see {initialize}). Usually deployed paused.
    /// @param mintTo Recipient for the deploy-time mint (`address(0)` = defer all minting).
    /// @param mintCount Tokens to mint in order (`[0, mintCount)`) to `mintTo` at deploy;
    ///        `== maxInvocations` mints the whole series. `<= maxInvocations`.
    /// @param tokenFields Optional on-chain metadata fields, keyed by token id. For large series,
    ///        set these post-deploy via `multicall(setTokenField…)` under a gas budget.
    /// @param contractFields Optional on-chain metadata fields for the collection.
    struct InitParams {
        address owner;
        string name;
        string symbol;
        string tokenURIBase;
        address tokenURIRenderer;
        string contractURIBase;
        address contractURIRenderer;
        address royaltyReceiver;
        uint16 royaltyBps;
        uint16 maxRoyaltyBps; // royalty ceiling (bps, 0–10000); reduce-only after deploy
        bool burnable; // opt-in burn; false = tokens can never be destroyed
        address transferValidator; // address(0) = plain ERC-721; else permanent 721C enrollment
        uint256 maxInvocations;
        address primaryPayee;
        address minter;
        bool paused;
        address mintTo;
        uint256 mintCount;
        IAbxOnChainMetadata.TokenFieldInput[] tokenFields;
        IAbxOnChainMetadata.FieldInput[] contractFields;
    }

    /// @notice The deploy-time mint count exceeds the series size.
    error MintCountExceedsMax();
    /// @notice A non-owner tried to mint while minting is paused.
    error MintingPaused();

    constructor() {
        // Lock the implementation: only clones (which start uninitialized) can initialize.
        _disableInitializers();
    }

    /// @notice One-time setup, called by the factory in the deploy transaction.
    /// @dev Event order: OwnershipTransferred → AbxDeployed → AbxExtensionVersionSet(royalty) →
    ///      MaxRoyaltyBpsUpdated → RoyaltyChangedForAll → BurnConfigured →
    ///      AbxExtensionVersionSet(max-invocations) → MaxInvocationsUpdated →
    ///      AbxExtensionVersionSet(external-minter) → [MinterSet] →
    ///      AbxExtensionVersionSet(primary-payee) → [PrimaryPayeeChanged] →
    ///      AbxExtensionVersionSet(paused) → [PausedStatusChanged(true)] →
    ///      AbxExtensionVersionSet(onchain-metadata) → TokenFieldSet* → ContractFieldSet* →
    ///      ContractURIUpdated → [AbxExtensionVersionSet(creator-token) → TransferValidatorUpdated] →
    ///      Transfer* (one per deploy-time mint) → Initialized(1).
    ///      `[…]` = emitted only when configured; `*` = once per entry. `Initialized(1)` is Solady's
    ///      initializer event; the factory then emits its own `Deployed`. `test/InitEventOrder.t.sol`
    ///      pins this sequence with every optional extension configured.
    /// @dev The deploy-time mint runs the internal `_mintNext` directly, **bypassing the paused
    ///      gate** (which lives on the public entrypoints) — so an owner's reserves mint at birth
    ///      even when deploying `paused`, exactly as intended. `mintTo == address(0)` defers all
    ///      minting whatever `mintCount` says.
    ///
    ///      The creator-token pair fires LAST of the extension inits, after ContractURIUpdated,
    ///      because enrollment is the only external call among them and every cap must be written
    ///      before that reentrancy window opens (see the body).
    function initialize(InitParams calldata p) external initializer {
        if (p.maxInvocations == 0) revert InvalidMaxInvocations();
        if (p.mintCount > p.maxInvocations) revert MintCountExceedsMax();

        _initOwner(p.owner);

        // stored values, no events: token-URI strategy + ERC-721 collection identity
        _initTokenURI(p.tokenURIBase, p.tokenURIRenderer);
        _initCollectionMetadata(p.name, p.symbol);

        // discovery beacon → extensions → contract-URI strategy → mints
        _emitAbxDeployed();
        _initRoyaltyExtension(p.royaltyReceiver, p.royaltyBps, p.maxRoyaltyBps);
        _initBurn(p.burnable);
        _initMaxInvocations(p.maxInvocations);
        _initExternalMinter(p.minter);
        _initPrimaryPayee(p.primaryPayee);
        _initPaused(p.paused);
        _initOnChainMetadataMulti(p.tokenFields, p.contractFields);
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

        // mint the first `mintCount` tokens in order to `mintTo`, or defer.
        if (p.mintTo != address(0)) {
            for (uint256 i; i < p.mintCount; ++i) {
                _mintNext(p.mintTo);
            }
        }
    }

    // ── minting ───────────────────────────────────────────────────────────────

    /// @notice The token id the next mint will assign (issuance cursor; `0,1,2,…`).
    function nextTokenId() external view returns (uint256) {
        return SeriesMintStorage.layout().nextTokenId;
    }

    /// @notice Mint the next sequential token to `to`; returns the id just minted.
    /// @dev The canonical {IAbxSequentialMint} primitive an external minter targets — recipient
    ///      only, id chosen by the contract, returns the id so a minter can report/compose.
    ///      Owner always; the authorized minter only when unpaused. Reverts if the series is sold out.
    function mint(address to) external override returns (uint256 tokenId) {
        _requireMintAuth();
        return _mintNext(to);
    }

    /// @notice Mint `count` tokens in order to `to` — N individual `Transfer`s. Batch issuance
    ///         (typically owner reserves); not part of {IAbxSequentialMint}. Same authorization as
    ///         {mint}: the owner always, the authorized minter while unpaused.
    /// @dev ERC-2309 batch signalling is intentionally not used.
    function mintMany(address to, uint256 count) external {
        _requireMintAuth();
        for (uint256 i; i < count; ++i) {
            _mintNext(to);
        }
    }

    /// @dev The single choke point for all mint paths: cap check → **reserve the id** → mint.
    ///      Returns the id minted (the pre-mint cursor value).
    ///
    ///      The cursor is committed before `_mint`, matching {SeriesCode-_mintNext}. No external
    ///      call sits between the read and the write today (no receiver hook, no seed draw, and the
    ///      transfer validator never sees a mint), so this ordering is not what keeps the current
    ///      path correct. It keeps `nextTokenId <= maxInvocations` and the {_maxInvocationsFloor}
    ///      promise independent of that fact, so a later change that adds a callback to this path
    ///      cannot reopen a check-then-effect window.
    function _mintNext(address to) internal returns (uint256 tokenId) {
        SeriesMintStorage.Layout storage m = SeriesMintStorage.layout();
        tokenId = m.nextTokenId;
        _requireWithinMax(tokenId); // sold-out guard (tokenId < maxInvocations)
        unchecked {
            m.nextTokenId = tokenId + 1; // reserve before minting
        }
        // `_mint`, deliberately, NOT `_safeMint`. The tradeoff, stated so it reads as a decision
        // rather than an omission: skipping `onERC721Received` saves the receiver call on every
        // purchase and keeps the mint path free of any callback, at the cost that `purchaseTo` can
        // deliver into a contract that cannot move it out. There is no clawback, and burning (where
        // the collection opted into it) needs the holder's own call, so that is unrecoverable. The
        // buyer names the recipient, and the sale path is the one place we most want free of
        // callbacks.
        _mint(to, tokenId); // Transfer(0x0, to, tokenId) — no receiver hook (as in OneOfOneImage)
    }

    /// @dev Mint authorization, composing {Ownable} + {Paused} + {ExternalMinter}:
    ///      the owner may always mint; while paused everyone else is blocked (reserves/config
    ///      stay with the owner); while unpaused the authorized minter may mint too. This is the
    ///      only place the three combine — the {Paused} extension itself is enforcement-neutral.
    function _requireMintAuth() internal view {
        if (msg.sender == owner()) return; // owner always may (reserves, config, primary sale)
        if (paused()) revert MintingPaused(); // paused ⇒ minter + public blocked
        if (msg.sender != minter()) revert NotMinterOrOwner();
    }

    // ── composition wiring ──────────────────────────────────────────────────--

    /// @dev The cap can't be lowered below the number of ids already ISSUED. Floors on the issuance
    ///      cursor, not on `totalSupply()`: the cursor never decreases, so no issued id is ever
    ///      stranded, whereas `totalSupply()` falls on burn and would let the cap drop below an id
    ///      that already exists. The cursor is committed before `_mint` (see {_mintNext}), so the
    ///      floor stays correct even if a later change adds a callback to the mint path — the
    ///      failure {SeriesCode} observed when its seed call could re-enter.
    function _maxInvocationsFloor() internal view override(MaxInvocations) returns (uint256) {
        return SeriesMintStorage.layout().nextTokenId;
    }

    /// @dev Compose ERC-165 by OR-ing the base and each mixin that defines supportsInterface.
    ///      (ContractURI defines none — ERC-7572 has no 165 id — so it's absent here.)
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(
            AbxErc721Base,
            TokenURI,
            OnChainMetadata,
            RoyaltyExtension,
            CreatorToken,
            MaxInvocations,
            ExternalMinter,
            PrimaryPayee,
            Paused
        )
        returns (bool)
    {
        return AbxErc721Base.supportsInterface(interfaceId)
            || TokenURI.supportsInterface(interfaceId)
            || OnChainMetadata.supportsInterface(interfaceId)
            || RoyaltyExtension.supportsInterface(interfaceId)
            || CreatorToken.supportsInterface(interfaceId)
            || MaxInvocations.supportsInterface(interfaceId)
            || ExternalMinter.supportsInterface(interfaceId)
            || PrimaryPayee.supportsInterface(interfaceId) || Paused.supportsInterface(interfaceId)
            || interfaceId == type(IAbxSequentialMint).interfaceId; // the mint primitive a minter targets
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

    /// @dev Diamond disambiguation only — the live-supply counter lives in {AbxErc721Base};
    ///      `super` routes the mint/burn hook there via C3 linearization.
    function _afterTokenTransfer(address from, address to, uint256 id)
        internal
        override(AbxErc721Base, ERC721)
    {
        super._afterTokenTransfer(from, to, id);
    }
}
