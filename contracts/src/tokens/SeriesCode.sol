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
import {SeedSourceExtension} from "../extensions/seed-source/SeedSourceExtension.sol";
import {ConfigurableParams} from "../extensions/configurable-params/ConfigurableParams.sol";
import {OnChainScript} from "../extensions/onchain-script/OnChainScript.sol";
import {Dependencies} from "../extensions/dependencies/Dependencies.sol";
import {IAbxSequentialMint} from "../interfaces/IAbxSequentialMint.sol";
import {SeriesMintStorage} from "../libraries/SeriesMintStorage.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {AbxCodeLib} from "../libraries/AbxCodeLib.sol";
import {IAbxOnChainMetadata} from "../extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @title SeriesCode — a multi-token code-project NFT (a program is the content)
/// @notice {SeriesImage}'s code-project sibling: the same sequential-drop composition — core
///         (`AbxErc721Base`) + URI strategies + `OnChainMetadata` + `RoyaltyExtension` +
///         `MaxInvocations` + `ExternalMinter` + `PrimaryPayee` + `Paused` — plus the
///         code-project extension set: `SeedSourceExtension` (configurable mint-time
///         randomness), `Params`/`ConfigurableParams` (inputs + governed PostParams),
///         `OnChainScript` + `Dependencies` (on-chain code custody, template mode). One class
///         serves **both custody modes**: an off-chain build directory is just a `code`
///         collection field; on-chain code is script chunks + deps (written post-deploy under a
///         gas budget via `multicall`). Deployed as an immutable EIP-1167 clone by
///         {SeriesCodeFactory}; never used directly.
///
/// @dev **The seed promise, enforced here:** at mint, if a seed source is configured and the
///      token has no pre-set (curated) seed, the token draws one and persists it as the `seed`
///      param (`updatedBy` = the source), *before* the `Transfer` so a transfer hook observes
///      it. Once set, `seed` is settled — the raw owner setters refuse it (`SeedSettled`)
///      unless a Configurable Params schema explicitly authorizes reconfiguration (then the
///      governed path applies). Token ids are strictly sequential; a token's metadata is its
///      token id — identical to {SeriesImage}.
contract SeriesCode is
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
    SeedSourceExtension,
    ConfigurableParams,
    OnChainScript,
    Dependencies,
    IAbxSequentialMint
{
    /// @dev The conventional mint-time randomness key (readable ASCII, like fields).
    bytes32 private constant SEED_KEY = "seed";

    /// @param owner Initial owner (creator); holds all admin rights.
    /// @param name ERC-721 collection name.
    /// @param symbol ERC-721 collection symbol.
    /// @param tokenURIBase Off-chain resolver base (used when tokenURIRenderer is 0).
    /// @param tokenURIRenderer On-chain metadata renderer; `address(0)` = resolve off-chain.
    /// @param contractURIBase Off-chain resolver base for the collection.
    /// @param contractURIRenderer On-chain renderer for the collection URI; `address(0)` = off-chain.
    /// @param royaltyReceiver Default royalty payee.
    /// @param royaltyBps Default royalty in basis points (<= the royalty cap).
    /// @param transferValidator Zero = a plain ERC-721 forever (the default). Non-zero =
    ///        permanently enrolled as an ERC-721C creator token with this validator (the owner
    ///        may re-point or suspend it later, never un-enroll).
    /// @param maxInvocations Series size N (> 0): the supply cap, monotonically non-increasing.
    /// @param primaryPayee Primary-sale payout destination (`address(0)` = none).
    /// @param minter Initial authorized minter (`address(0)` = owner-only).
    /// @param paused Initial mint-pause state (usually deployed paused).
    /// @param seedSource IAbxSeedSource the token calls at mint (`address(0)` = no mint-time
    ///        seed — post-mint schemas, curated seeds, or non-generative code).
    /// @param disableTokenOwnerDelegation Opt out of delegate.xyz on the TokenOwner auth leg.
    ///        Default (`false`) = the canonical v2 registry — vaulted tokens configure params
    ///        from a delegated hot wallet. The owner can re-point/disable later
    ///        (`setDelegateRegistry`).
    /// @param mintTo Recipient for the deploy-time mint (`address(0)` = defer all minting).
    /// @param mintCount Tokens to mint in order to `mintTo` at deploy; `<= maxInvocations`.
    /// @param tokenFields Optional on-chain metadata fields, keyed by token id.
    /// @param contractFields Optional collection fields — a directory-mode project sets `code`
    ///        here (locator representations only; on-chain code is the script extension).
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
        address seedSource;
        bool disableTokenOwnerDelegation;
        address mintTo;
        uint256 mintCount;
        IAbxOnChainMetadata.TokenFieldInput[] tokenFields;
        IAbxOnChainMetadata.FieldInput[] contractFields;
    }

    /// @notice The deploy-time mint count exceeds the series size.
    error MintCountExceedsMax();
    /// @notice A non-owner tried to mint while minting is paused.
    error MintingPaused();
    /// @notice `seed` is assigned and settled — nothing may rewrite, re-shape, or clear it.
    /// @dev Declared for this contract's ABI; the rule itself is enforced once, structurally, in
    ///      {AbxParamsLib} — the single choke point every external param write passes through, so
    ///      no schema, lock state, or reentrant ordering can route around it. Same selector.
    error SeedSettled();

    constructor() {
        // Lock the implementation: only clones (which start uninitialized) can initialize.
        _disableInitializers();
    }

    /// @notice One-time setup, called by the factory in the deploy transaction.
    /// @dev Event order mirrors {SeriesImage} with the code-project extensions appended:
    ///      OwnershipTransferred → AbxDeployed → AbxExtensionVersionSet(royalty) →
    ///      RoyaltyChangedForAll →
    ///      …(max-invocations, external-minter, primary-payee, paused)… →
    ///      AbxExtensionVersionSet(seed-source) → [SeedSourceSet] →
    ///      AbxExtensionVersionSet(params) → AbxExtensionVersionSet(configurable-params) →
    ///      [DelegateRegistrySet(0), only when delegation is opted out] →
    ///      AbxExtensionVersionSet(onchain-script) → AbxExtensionVersionSet(dependencies) →
    ///      AbxExtensionVersionSet(onchain-metadata) → TokenFieldSet*/ContractFieldSet* →
    ///      ContractURIUpdated → (per deploy-time mint) TokenParamConfigured("seed") + Transfer.
    ///      Script chunks, dependencies, and schemas are post-deploy owner ops (`multicall`
    ///      under a gas budget) — a script is far too large for a fat initialize.
    ///
    ///      The creator-token pair — [AbxExtensionVersionSet(creator-token) →
    ///      TransferValidatorUpdated] — fires LAST of the extension inits, after
    ///      ContractURIUpdated, because enrollment is the only external call here and every
    ///      cap must be written before that reentrancy window opens (see the body).
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
        _initSeedSource(p.seedSource);
        _initParams();
        _initConfigurableParams(p.disableTokenOwnerDelegation);
        _initOnChainScript();
        _initDependencies();
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
    /// @dev The canonical {IAbxSequentialMint} primitive an external minter targets. Owner
    ///      always; the authorized minter only when unpaused. Reverts when sold out.
    function mint(address to) external override returns (uint256 tokenId) {
        _requireMintAuth();
        return _mintNext(to);
    }

    /// @notice Mint `count` tokens in order to `to` — N individual `Transfer`s (owner reserves).
    function mintMany(address to, uint256 count) external {
        _requireMintAuth();
        for (uint256 i; i < count; ++i) {
            _mintNext(to);
        }
    }

    /// @dev The single choke point for all mint paths: cap check → **reserve the id** → seed →
    ///      mint. The seed is drawn *before* the `Transfer` so a transfer hook observes it; a
    ///      pre-set (creator-curated) seed wins over the source — the source fills gaps, never
    ///      overwrites.
    ///
    ///      The cursor is advanced *before* drawing the seed, and that ordering is load-bearing.
    ///      `_drawSeed` calls an owner-supplied contract (`IAbxSeedSource` is non-view by design),
    ///      so it is a reentrancy point sitting between a check and its effect. Committing the id
    ///      first means a reentrant frame reads the *next* cursor value and runs its own cap check
    ///      against committed state, so `nextTokenId <= maxInvocations` holds no matter how the
    ///      call nests. Previously the cursor was written last, and the only thing stopping a
    ///      reentrant mint was Solady reverting `TokenAlreadyExists` on the duplicate id — correct
    ///      by accident, and silently lost the moment ids stopped being strictly sequential.
    function _mintNext(address to) internal returns (uint256 tokenId) {
        SeriesMintStorage.Layout storage m = SeriesMintStorage.layout();
        tokenId = m.nextTokenId;
        _requireWithinMax(tokenId); // sold-out guard (tokenId < maxInvocations)
        unchecked {
            m.nextTokenId = tokenId + 1; // reserve before any external call
        }
        if (!_tokenParamIsSet(tokenId, SEED_KEY)) {
            (bool drawn, bytes32 value, address source) = _drawSeed(tokenId, to);
            if (drawn) _setTokenParam(tokenId, SEED_KEY, value, false, source);
        }
        // `_mint`, deliberately, NOT `_safeMint`. The tradeoff, stated so it reads as a decision
        // rather than an omission: skipping `onERC721Received` saves the receiver call on every
        // purchase and removes a reentrancy surface from the mint path, at the cost that
        // `purchaseTo` can deliver into a contract that cannot move it out. A 721 has no burn and
        // no clawback here, so that is unrecoverable. The buyer names the recipient, and the sale
        // path is the one place we most want free of callbacks.
        _mint(to, tokenId); // Transfer(0x0, to, tokenId) — no receiver hook (matches Series)
    }

    /// @dev Mint authorization, composing {Ownable} + {Paused} + {ExternalMinter} — identical
    ///      to {SeriesImage}: owner always; paused blocks everyone else; else the minter too.
    function _requireMintAuth() internal view {
        if (msg.sender == owner()) return;
        if (paused()) revert MintingPaused();
        if (msg.sender != minter()) revert NotMinterOrOwner();
    }

    // ── composition wiring ──────────────────────────────────────────────────--

    /// @dev The cap can't be lowered below the number of ids already ISSUED. Floors on the issuance
    ///      cursor, not on `totalSupply()`, and the difference is load-bearing: the cursor is
    ///      committed before the mint-time seed call, so it is correct even mid-frame, whereas
    ///      `totalSupply()` is written inside `_mint` and reads stale while a reentrant mint is in
    ///      flight — which let a nested mint drive supply past a cap that had already been lowered
    ///      (observed `totalSupply() == 3` against `maxInvocations() == 1`). The cursor is also the
    ///      honest quantity for this promise: it never decreases, so no issued id is ever stranded.
    function _maxInvocationsFloor() internal view override(MaxInvocations) returns (uint256) {
        return SeriesMintStorage.layout().nextTokenId;
    }

    /// @dev Compose ERC-165 by OR-ing the base and each mixin that defines supportsInterface.
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
            Paused,
            SeedSourceExtension,
            ConfigurableParams,
            OnChainScript,
            Dependencies
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
            || SeedSourceExtension.supportsInterface(interfaceId)
            || ConfigurableParams.supportsInterface(interfaceId)
            || OnChainScript.supportsInterface(interfaceId)
            || Dependencies.supportsInterface(interfaceId)
            || interfaceId == type(IAbxSequentialMint).interfaceId;
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

    /// @dev Supply counter (via {AbxErc721Base}) + the veto-capable transfer-hook notification —
    ///      the param lifecycle's ownership-change signal (mint = from `0x0`, burn = to `0x0`).
    function _afterTokenTransfer(address from, address to, uint256 id)
        internal
        override(AbxErc721Base, ERC721)
    {
        super._afterTokenTransfer(from, to, id);
        _notifyTransferHook(id, from, to);
    }


}
