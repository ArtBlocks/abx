// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {ERC1155} from "solady/tokens/ERC1155.sol";

import {AbxErc1155Base} from "../core/AbxErc1155Base.sol";
import {Uri1155} from "../uri/token/Uri1155.sol";
import {ContractURI} from "../uri/contract/ContractURI.sol";
import {RoyaltyExtension} from "../extensions/royalty/RoyaltyExtension.sol";
import {CreatorToken1155} from "../extensions/creator-token/CreatorToken1155.sol";
import {OnChainMetadata} from "../extensions/onchain-metadata/OnChainMetadata.sol";
import {EditionSupply} from "../extensions/edition-supply/EditionSupply.sol";
import {MaxInvocations} from "../extensions/max-invocations/MaxInvocations.sol";
import {ExternalMinter} from "../extensions/external-minter/ExternalMinter.sol";
import {PrimaryPayee} from "../extensions/primary-payee/PrimaryPayee.sol";
import {Paused} from "../extensions/paused/Paused.sol";
import {SeedSourceExtension} from "../extensions/seed-source/SeedSourceExtension.sol";
import {ConfigurableParams} from "../extensions/configurable-params/ConfigurableParams.sol";
import {OnChainScript} from "../extensions/onchain-script/OnChainScript.sol";
import {Dependencies} from "../extensions/dependencies/Dependencies.sol";
import {IAbxEditionMint} from "../interfaces/IAbxEditionMint.sol";
import {Erc1155SupplyStorage} from "../libraries/Erc1155SupplyStorage.sol";
import {AbxEditionLib} from "../libraries/AbxEditionLib.sol";
import {ConfigurableParamsStorage} from "../libraries/ConfigurableParamsStorage.sol";
import {IAbxOnChainMetadata} from "../extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @title EditionCode — copies of many distinct generative works (ERC-1155, a program is the content)
/// @notice {EditionImage}'s code-project sibling — the exact same generative extension set
///         {SeriesCode} adds to {SeriesImage}: `SeedSourceExtension` (configurable mint-time
///         randomness), `Params`/`ConfigurableParams` (inputs + governed PostParams),
///         `OnChainScript` + `Dependencies` (on-chain code custody, template mode) — all
///         already per-id and standard-agnostic, composing onto the 1155 stack unchanged.
///         Deployed as an immutable EIP-1167 clone by {EditionCodeFactory}; never used directly.
/// @dev **The seed promise, generalized to "first mint of an id" instead of "the mint":** a
///      Series token mints each id exactly once, so {SeriesCode} draws a seed at *the* mint. An
///      edition id can be minted many times (more copies), so the seed draws once per id, at a mint
///      that finds the id with no live copies and no seed — in practice its first mint. Every copy
///      of the same id shares that one seed, since the seed belongs to the WORK (the id), not to
///      any individual copy. (Edge: if no seed source was set at the first mint, the id has no
///      seed; a later mint draws one only after every copy has been burned.) Once
///      set, `seed` is settled exactly like {SeriesCode}: the raw owner setters refuse it, a schema
///      declared after the fact is refused, and a seed source re-entering mid-mint is refused
///      (`SeedSettled`, enforced in {AbxParamsLib}).
///
///      **The one carve-out — and it is edition-specific.** If the creator declared a `seed` schema
///      BEFORE the first mint (the opt-in reassignable-seed feature), that schema's auth governs the
///      seed thereafter. On a 721 that means "the token's owner may re-pick their own seed." On an
///      EDITION the seed is shared by every holder of the id, and `TokenOwner` means ANY holder — so
///      a `TokenOwner` `seed` schema lets any single holder re-roll the seed for ALL co-holders of
///      the work. That is a disclosed, buyer-verifiable choice (`paramSchema("seed")` reveals it),
///      not the default (with no `seed` schema the seed is immutable, full stop). The CLI warns a
///      creator who declares it; the protocol permits it. So "a collector's work cannot be changed
///      out from under them" holds by default, and holds absolutely for any project without a
///      reassignable `seed` schema.
///      The id high-water mark and `_maxInvocationsFloor()` wiring are identical to {EditionImage}
///      — see its class-level dev note.
contract EditionCode is
    AbxErc1155Base,
    Uri1155,
    ContractURI,
    OnChainMetadata,
    RoyaltyExtension,
    CreatorToken1155,
    EditionSupply,
    MaxInvocations,
    ExternalMinter,
    PrimaryPayee,
    Paused,
    SeedSourceExtension,
    ConfigurableParams,
    OnChainScript,
    Dependencies,
    IAbxEditionMint
{
    /// @dev The conventional mint-time randomness key (readable ASCII, like fields).
    bytes32 private constant SEED_KEY = "seed";

    /// @param owner Initial owner (creator); holds all admin rights.
    /// @param name Collection name.
    /// @param symbol Collection symbol.
    /// @param tokenURIBase Off-chain resolver base (used when tokenURIRenderer is 0).
    /// @param tokenURIRenderer On-chain metadata renderer; `address(0)` = resolve off-chain.
    /// @param contractURIBase Off-chain resolver base for the collection.
    /// @param contractURIRenderer On-chain renderer for the collection URI; `address(0)` = off-chain.
    /// @param royaltyReceiver Default royalty payee.
    /// @param royaltyBps Default royalty in basis points (<= the royalty cap).
    /// @param maxRoyaltyBps Royalty ceiling in basis points (0–10000), reduce-only after deploy.
    /// @param burnable Opt-in burn, fixed at deploy; `false` means copies can never be destroyed.
    /// @param transferValidator Zero = a plain ERC-1155 forever. Non-zero = permanent ERC-1155C
    ///        enrollment with this validator.
    /// @param maxInvocations The id-space cap N (> 0): the number of distinct works, monotonically
    ///        non-increasing (floor = the id high-water mark; see {EditionImage}).
    /// @param editionSize The default per-id copy cap for every id (`0` = open edition, uncapped).
    /// @param primaryPayee Primary-sale payout destination (`address(0)` = none).
    /// @param minter Initial authorized minter (`address(0)` = owner-only).
    /// @param paused Initial mint-pause state (usually deployed paused).
    /// @param seedSource IAbxSeedSource the token calls at each id's FIRST mint (`address(0)` = no
    ///        mint-time seed — post-mint schemas, curated seeds, or non-generative code).
    /// @param mintTo Recipient for the deploy-time mint (`address(0)` = defer all minting).
    /// @param mintCount Distinct works to mint at deploy, ids `[0, mintCount)`; `<= maxInvocations`.
    /// @param mintAmount Copies of EACH deploy-minted id (must be `> 0` if `mintCount > 0`).
    /// @param tokenFields Optional on-chain metadata fields, keyed by id.
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
        bool burnable; // opt-in burn; false = copies can never be destroyed
        address transferValidator;
        uint256 maxInvocations;
        uint256 editionSize;
        address primaryPayee;
        address minter;
        bool paused;
        address seedSource;
        address mintTo;
        uint256 mintCount;
        uint256 mintAmount;
        IAbxOnChainMetadata.TokenFieldInput[] tokenFields;
        IAbxOnChainMetadata.FieldInput[] contractFields;
    }

    /// @notice The deploy-time mint count exceeds the id-space cap.
    error MintCountExceedsMax();
    /// @notice A non-owner tried to mint while minting is paused.
    error MintingPaused();
    /// @notice A mint amount of 0 copies was requested.
    error ZeroMintAmount();

    constructor() {
        // Lock the implementation: only clones (which start uninitialized) can initialize.
        _disableInitializers();
    }

    /// @notice One-time setup, called by the factory in the deploy transaction.
    /// @dev Event order: OwnershipTransferred → AbxDeployed → AbxExtensionVersionSet(royalty) →
    ///      MaxRoyaltyBpsUpdated → RoyaltyChangedForAll → BurnConfigured →
    ///      AbxExtensionVersionSet(max-invocations) → MaxInvocationsUpdated →
    ///      AbxExtensionVersionSet(edition-supply) → DefaultMaxSupplySet →
    ///      AbxExtensionVersionSet(external-minter) → [MinterSet] →
    ///      AbxExtensionVersionSet(primary-payee) → [PrimaryPayeeChanged] →
    ///      AbxExtensionVersionSet(paused) → [PausedStatusChanged(true)] →
    ///      AbxExtensionVersionSet(seed-source) → [SeedSourceSet] →
    ///      AbxExtensionVersionSet(params) → AbxExtensionVersionSet(configurable-params) →
    ///      AbxExtensionVersionSet(onchain-script) → AbxExtensionVersionSet(dependencies) →
    ///      AbxExtensionVersionSet(onchain-metadata) → TokenFieldSet* → ContractFieldSet* →
    ///      ContractURIUpdated → [AbxExtensionVersionSet(creator-token) → TransferValidatorUpdated] →
    ///      per deploy-time id: [TokenParamConfigured("seed") → MetadataUpdate] → TransferSingle →
    ///      Initialized(1). Editions have no TokenOwner-leg delegation to opt out of (see
    ///      {ConfigurableParams-_initConfigurableParamsForEdition}), so unlike {SeriesCode} no
    ///      `DelegateRegistrySet` ever fires here. `mintTo == address(0)` defers all minting
    ///      whatever `mintCount`/`mintAmount` say.
    ///      `[…]` = emitted only when configured; `*` = once per entry. `Initialized(1)` is Solady's
    ///      initializer event; the factory then emits its own `Deployed`. `test/InitEventOrder.t.sol`
    ///      pins this sequence with every optional extension configured.
    ///      Script chunks, dependencies, and schemas are post-deploy owner ops (`multicall` under
    ///      a gas budget) — a script is far too large for a fat initialize.
    ///
    ///      The creator-token pair fires LAST of the extension inits, after ContractURIUpdated,
    ///      because enrollment is the only external call among them and every cap must be written
    ///      before that reentrancy window opens (see the body).
    function initialize(InitParams calldata p) external initializer {
        if (p.maxInvocations == 0) revert InvalidMaxInvocations();
        if (p.mintCount > p.maxInvocations) revert MintCountExceedsMax();

        _initOwner(p.owner);

        // stored values, no events: token-URI strategy + collection identity
        _initTokenURI(p.tokenURIBase, p.tokenURIRenderer);
        _initCollectionMetadata(p.name, p.symbol);

        // discovery beacon → extensions → contract-URI strategy → mints
        _emitAbxDeployed();
        _initRoyaltyExtension(p.royaltyReceiver, p.royaltyBps, p.maxRoyaltyBps);
        _initBurn(p.burnable);
        _initMaxInvocations(p.maxInvocations);
        _initEditionSupply(p.editionSize);
        _initExternalMinter(p.minter);
        _initPrimaryPayee(p.primaryPayee);
        _initPaused(p.paused);
        _initSeedSource(p.seedSource);
        _initParams();
        _initConfigurableParamsForEdition();
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

        // mint `mintAmount` copies of each of the first `mintCount` ids to `mintTo`, or defer.
        if (p.mintTo != address(0)) {
            for (uint256 i; i < p.mintCount; ++i) {
                _mintEditionId(p.mintTo, i, p.mintAmount);
            }
        }
    }

    // ── minting ───────────────────────────────────────────────────────────────

    /// @inheritdoc IAbxEditionMint
    /// @dev Owner always; the authorized minter only when unpaused. Guards, in order: amount > 0,
    ///      the id-space cap, then the per-id copy cap.
    function mint(address to, uint256 id, uint256 amount) external override {
        _requireMintAuth();
        _mintEditionId(to, id, amount);
    }

    /// @dev The single choke point for all mint paths: guards → id high-water mark → seed (on the
    ///      id's FIRST mint only) → mint. The seed is drawn *before* `_mint` so a transfer hook
    ///      observes it; a pre-set (creator-curated) seed wins over the source — the source fills
    ///      gaps, never overwrites. The watermark bump + seed draw is delegated to
    ///      {AbxEditionLib-advanceWatermarkAndDrawSeed} (EIP-170 relief; identical semantics) —
    ///      `_mint` itself stays here, since Solady's `_mint` is `internal` and invisible to an
    ///      external library.
    function _mintEditionId(address to, uint256 id, uint256 amount) internal {
        if (amount == 0) revert ZeroMintAmount();
        _requireWithinMax(id); // id-space guard (id < maxInvocations) — pure storage read
        // The seed draw calls an owner-supplied contract (`IAbxSeedSource` is non-view by design),
        // so it must not sit between the per-id cap check and the `_mint` that commits the counter
        // the check reads: a reentrant source would otherwise see the same unwritten
        // `totalSupply(id)` in every frame and mint past `maxSupply(id)` — overselling an edition
        // whose cap collectors verified on chain. Drawing first leaves check and effect adjacent,
        // so a nested mint commits before the outer check runs and the cap always binds.
        AbxEditionLib.advanceWatermarkAndDrawSeed(id, to, SEED_KEY);
        _requireWithinEditionCap(id, amount); // per-id copy cap, read fresh
        _mint(to, id, amount, ""); // TransferSingle(0x0, to, id, amount)
    }

    /// @dev Mint authorization, composing {Ownable} + {Paused} + {ExternalMinter} — identical
    ///      shape to the 721 twins' `_requireMintAuth`.
    function _requireMintAuth() internal view {
        if (msg.sender == owner()) return;
        if (paused()) revert MintingPaused();
        if (msg.sender != minter()) revert NotMinterOrOwner();
    }

    // ── composition wiring ──────────────────────────────────────────────────--

    /// @dev The id-space cap can't be lowered below any work that has ever had a copy minted —
    ///      see {EditionImage}'s class-level dev note on the id high-water mark.
    function _maxInvocationsFloor() internal view override(MaxInvocations) returns (uint256) {
        return Erc1155SupplyStorage.layout().idWatermark;
    }

    /// @dev Compose ERC-165 by OR-ing the base and each mixin that defines supportsInterface.
    ///      `ERC1155` must be named too: `Uri1155` inherits it via a second path to the same
    ///      original declaration, so Solidity treats it as its own diamond leg — exactly why the
    ///      721 twins also name `ERC721` here even though `AbxErc1155Base` already resolved it once.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(
            ERC1155,
            AbxErc1155Base,
            OnChainMetadata,
            RoyaltyExtension,
            CreatorToken1155,
            EditionSupply,
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
        return AbxErc1155Base.supportsInterface(interfaceId)
            || OnChainMetadata.supportsInterface(interfaceId)
            || RoyaltyExtension.supportsInterface(interfaceId)
            || CreatorToken1155.supportsInterface(interfaceId)
            || EditionSupply.supportsInterface(interfaceId)
            || MaxInvocations.supportsInterface(interfaceId)
            || ExternalMinter.supportsInterface(interfaceId)
            || PrimaryPayee.supportsInterface(interfaceId) || Paused.supportsInterface(interfaceId)
            || SeedSourceExtension.supportsInterface(interfaceId)
            || ConfigurableParams.supportsInterface(interfaceId)
            || OnChainScript.supportsInterface(interfaceId)
            || Dependencies.supportsInterface(interfaceId)
            || interfaceId == type(IAbxEditionMint).interfaceId;
    }

    /// @dev Same multi-path reason as `supportsInterface` above: `Uri1155`'s separate inheritance
    ///      of `ERC1155` leaves its (default `false`) gate declaration in the diamond alongside
    ///      `AbxErc1155Base`'s (`true`) override, so the concrete token must resolve it once more.
    function _useBeforeTokenTransfer()
        internal
        view
        override(AbxErc1155Base, ERC1155)
        returns (bool)
    {
        return true;
    }

    /// @dev See {_useBeforeTokenTransfer}.
    function _useAfterTokenTransfer()
        internal
        view
        override(AbxErc1155Base, ERC1155)
        returns (bool)
    {
        return true;
    }

    /// @dev Creator-token wiring: when enrolled with a live validator, every real transfer (never
    ///      a mint/burn) must pass the validator's policy check before moving.
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) internal override(ERC1155) {
        super._beforeTokenTransfer(from, to, ids, amounts, data);
        _validateTransfer1155(from, to, ids, amounts);
    }

    /// @dev Supply counter (via {AbxErc1155Base}) + the veto-capable transfer-hook notification —
    ///      the param lifecycle's ownership-change signal, once per transferred id with a non-zero
    ///      amount (mint = from `0x0`, burn = to `0x0`; a self-transfer changes no holder and is not
    ///      reported). The notify loop lives in {AbxEditionLib-notifyTransferHookForIds}; the two
    ///      cheap exits run here first so a collection with no transfer hook, and a self-transfer,
    ///      never pay the library hop.
    function _afterTokenTransfer(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) internal override(AbxErc1155Base, ERC1155) {
        super._afterTokenTransfer(from, to, ids, amounts, data);
        if (from == to || ConfigurableParamsStorage.layout().transferHook == address(0)) return;
        AbxEditionLib.notifyTransferHookForIds(ids, amounts, from, to, msg.sender);
    }
}
