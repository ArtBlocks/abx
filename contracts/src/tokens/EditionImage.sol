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
import {IAbxEditionMint} from "../interfaces/IAbxEditionMint.sol";
import {Erc1155SupplyStorage} from "../libraries/Erc1155SupplyStorage.sol";
import {AbxEditionLib} from "../libraries/AbxEditionLib.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {IAbxOnChainMetadata} from "../extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @title EditionImage — copies of many distinct works (ERC-1155, N works × copies each)
/// @notice The ERC-1155 sibling of {SeriesImage}: {OneOfOneEdition}'s full stack plus
///         `MaxInvocations`, reused as-is with its meaning unchanged — the number of distinct
///         works (ids) the project may ever have, NOT the copies of any one of them (that's
///         `EditionSupply`, per id). Deployed as an immutable EIP-1167 clone by
///         {EditionImageFactory}; never used directly.
/// @dev **Ids are caller-named, not a sequential cursor.** Unlike {SeriesImage} (`mint(to)` picks
///      the next id automatically), {IAbxEditionMint}'s `mint(to, id, amount)` lets a minter
///      target any `id < maxInvocations` in any order — a collector buys copies of the specific
///      work they want. That breaks the 721 twins' "totalSupply() IS the floor" shortcut for
///      lowering `maxInvocations`: there's no natural "tokens minted so far" cursor here. Instead
///      this token maintains its own monotonic **id high-water mark**
///      (`Erc1155SupplyStorage.idWatermark` — the highest id + 1 ever minted, never decremented
///      even by a full burn) and uses it as {MaxInvocations}'s floor, so the owner can never lower
///      the id-space cap below a work that has ever had a copy minted (the same
///      no-stranding promise the 721 twin protects via `totalSupply()`, generalized to
///      non-sequential id assignment).
contract EditionImage is
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
    IAbxEditionMint
{
    /// @param owner Initial owner (creator); holds all admin rights.
    /// @param name Collection name.
    /// @param symbol Collection symbol.
    /// @param tokenURIBase Off-chain resolver base for `uri(id)` (used when tokenURIRenderer is 0).
    /// @param tokenURIRenderer On-chain renderer; `address(0)` = resolve off-chain.
    /// @param contractURIBase Off-chain resolver base for the collection.
    /// @param contractURIRenderer On-chain renderer for the collection URI; `address(0)` = off-chain.
    /// @param royaltyReceiver Default royalty payee.
    /// @param royaltyBps Default royalty in basis points (<= the royalty cap).
    /// @param transferValidator Zero = a plain ERC-1155 forever. Non-zero = permanent ERC-1155C
    ///        enrollment with this validator.
    /// @param maxInvocations The id-space cap N (> 0): the number of distinct works this
    ///        project may ever have. Monotonically non-increasing (floor = the id high-water mark).
    /// @param editionSize The default per-id copy cap for every id (`0` = open edition, uncapped).
    /// @param primaryPayee Primary-sale payout destination (`address(0)` = none).
    /// @param minter Initial authorized minter (`address(0)` = owner-only).
    /// @param paused Initial mint-pause state (usually deployed paused).
    /// @param mintTo Recipient for the deploy-time mint (`address(0)` = defer all minting).
    /// @param mintCount Distinct works to mint at deploy, ids `[0, mintCount)`; `<= maxInvocations`.
    /// @param mintAmount Copies of EACH deploy-minted id (must be `> 0` if `mintCount > 0`).
    /// @param tokenFields Optional on-chain metadata fields, keyed by id.
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
        bool burnable; // opt-in burn; false = copies can never be destroyed
        address transferValidator;
        uint256 maxInvocations;
        uint256 editionSize;
        address primaryPayee;
        address minter;
        bool paused;
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
    /// @dev Event order mirrors {SeriesImage} with the 1155 extensions substituted:
    ///      OwnershipTransferred → AbxDeployed → AbxExtensionVersionSet(royalty) →
    ///      RoyaltyChangedForAll → AbxExtensionVersionSet(max-invocations) →
    ///      MaxInvocationsUpdated → AbxExtensionVersionSet(edition-supply) →
    ///      AbxExtensionVersionSet(external-minter) → [MinterSet] →
    ///      AbxExtensionVersionSet(primary-payee) → [PrimaryPayeeChanged] →
    ///      AbxExtensionVersionSet(paused) → [PausedStatusChanged(true)] →
    ///      AbxExtensionVersionSet(onchain-metadata) → TokenFieldSet*/ContractFieldSet* →
    ///      ContractURIUpdated → (per deploy-time id) TransferSingle.
    /// @dev The deploy-time mint runs the internal `_mintEditionId` directly, bypassing the
    ///      paused gate (which lives on the public entrypoint) — owner reserves mint at birth
    ///      even when deploying paused, exactly like the 721 twins.
    ///
    ///      The creator-token pair — [AbxExtensionVersionSet(creator-token) →
    ///      TransferValidatorUpdated] — fires LAST of the extension inits, after
    ///      ContractURIUpdated, because enrollment is the only external call here and every
    ///      cap must be written before that reentrancy window opens (see the body).
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
    ///      the id-space cap (`id < maxInvocations`), then the per-id copy cap.
    function mint(address to, uint256 id, uint256 amount) external override {
        _requireMintAuth();
        _mintEditionId(to, id, amount);
    }

    /// @dev The single choke point for all mint paths: guards → the id high-water mark → mint.
    function _mintEditionId(address to, uint256 id, uint256 amount) internal {
        if (amount == 0) revert ZeroMintAmount();
        _requireWithinMax(id); // id-space guard (id < maxInvocations)
        _requireWithinEditionCap(id, amount); // per-id copy cap
        Erc1155SupplyStorage.Layout storage l = Erc1155SupplyStorage.layout();
        if (id >= l.idWatermark) l.idWatermark = id + 1; // extend the no-stranding floor
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
    ///      see the class-level dev note on the id high-water mark.
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
            Paused
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

    /// @dev Diamond disambiguation only — the live per-id supply counter lives in
    ///      {AbxErc1155Base}; `super` routes the mint/burn hook there via C3 linearization.
    function _afterTokenTransfer(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) internal override(AbxErc1155Base, ERC1155) {
        super._afterTokenTransfer(from, to, ids, amounts, data);
    }
    // ── {Uri1155} / {CreatorToken1155} / {EditionSupply} bodies, delegated ────────
    //
    // Same extraction {EditionCode} performs, for the same reason and by the same pattern: the
    // ERC-4906 refresh emissions the audit remediation added pushed this contract under its EIP-170
    // policy floor, and the floor is the point. Access control (`onlyOwner`) stays on these
    // overrides; the library assumes its caller already gated.
    //
    // This contract was previously held library-free on the stated grounds that linking one would
    // cost its factory a CREATE2-deterministic address. That premise does not survive the broadcast
    // artifacts: every recorded library deploy goes through the keyless CREATE2 proxy at salt zero,
    // `AbxParamsLib` landed at one address on two chains from deployer nonces 215 apart, and both
    // library-linked factories already hold chain-identical addresses across four generations.
    // Libraries deployed deterministically, implementations deterministically, factories
    // deterministically — the chain is deterministic end to end. What linking really costs is
    // operational: the library must exist before the factory on each chain, a library redeploy
    // re-addresses every linked factory, and the `--libraries` pin in the deploy script becomes
    // mandatory. Real tax, paid knowingly, and cheaper than eroding a size floor a second time.

}
