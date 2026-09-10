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
import {ExternalMinter} from "../extensions/external-minter/ExternalMinter.sol";
import {PrimaryPayee} from "../extensions/primary-payee/PrimaryPayee.sol";
import {Paused} from "../extensions/paused/Paused.sol";
import {IAbxEditionMint} from "../interfaces/IAbxEditionMint.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {AbxEditionLib} from "../libraries/AbxEditionLib.sol";
import {IAbxOnChainMetadata} from "../extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @title OneOfOneEdition — copies of a single work (ERC-1155, id space fixed to {0})
/// @notice The ERC-1155 twin of {OneOfOneImage} — but with a deliberate asymmetry: unlike a 1/1
///         image (one-shot, owner-only, no sale stack), a priced open or limited edition of a
///         single work is THE dominant 1155 product, so this token ships the full sale stack
///         from day one: `ExternalMinter` + `PrimaryPayee` + `Paused` + `EditionSupply`, plus the
///         same core composition as the 721 side — `AbxErc1155Base` + the `Uri1155`/`ContractURI`
///         strategies + `RoyaltyExtension` + `OnChainMetadata` + `CreatorToken1155`. One contract
///         = one work = id `0`; `editionSize` (0 = open) caps how many copies of it may ever
///         exist. Deployed as an immutable EIP-1167 clone by {OneOfOneEditionFactory}; never used
///         directly.
contract OneOfOneEdition is
    AbxErc1155Base,
    Uri1155,
    ContractURI,
    OnChainMetadata,
    RoyaltyExtension,
    CreatorToken1155,
    EditionSupply,
    ExternalMinter,
    PrimaryPayee,
    Paused,
    IAbxEditionMint
{
    /// @notice The single work's id.
    uint256 internal constant TOKEN_ID = 0;

    /// @param owner Initial owner (creator); holds all admin rights.
    /// @param mintTo Recipient of the deploy-time mint (`address(0)` = defer all minting).
    /// @param mintAmount Copies of id `0` to mint to `mintTo` at deploy (`0` = none).
    /// @param name Collection name (ERC-1155 has no standard name/symbol; kept for the renderer
    ///        and marketplaces, exactly like the 721 twins).
    /// @param symbol Collection symbol.
    /// @param tokenURIBase Off-chain resolver base for `uri(id)` (used when tokenURIRenderer is
    ///        0); the pointer is derived on-chain as `{base}/{chainId}/{address}/{id}`.
    /// @param tokenURIRenderer On-chain renderer for `uri(id)`; `address(0)` = resolve off-chain
    ///        via the base. Non-zero = assemble the JSON on-chain from the fields.
    /// @param contractURIBase Off-chain resolver base for the collection (used when
    ///        contractURIRenderer is 0); derived on-chain as `{base}/{chainId}/{address}`.
    /// @param contractURIRenderer On-chain renderer for the collection URI; `address(0)` = off-chain.
    /// @param royaltyReceiver Default royalty payee.
    /// @param royaltyBps Default royalty in basis points (<= the royalty cap).
    /// @param transferValidator Zero = a plain ERC-1155 forever (the default). Non-zero =
    ///        permanently enrolled as an ERC-1155C creator token with this validator (the owner
    ///        may re-point or suspend it later, never un-enroll).
    /// @param editionSize The default supply cap for id 0 (`0` = open edition, uncapped).
    /// @param primaryPayee Primary-sale payout destination (`address(0)` = none).
    /// @param minter Initial authorized minter — a single address (`address(0)` = owner-only).
    /// @param paused Initial mint-pause state — `true` restricts minting to the owner until
    ///        unpaused (deploy-time reserves still mint; see {initialize}).
    /// @param tokenFields Optional on-chain metadata fields for id 0 (each field → one representation).
    /// @param contractFields Optional on-chain metadata fields for the collection.
    struct InitParams {
        address owner;
        address mintTo;
        uint256 mintAmount;
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
        uint256 editionSize;
        address primaryPayee;
        address minter;
        bool paused;
        IAbxOnChainMetadata.FieldInput[] tokenFields;
        IAbxOnChainMetadata.FieldInput[] contractFields;
    }

    /// @notice `mint` was called with an id other than 0 — the id space is fixed to the single work.
    error InvalidTokenId();
    /// @notice A mint amount of 0 copies was requested.
    error ZeroMintAmount();
    /// @notice A non-owner tried to mint while minting is paused.
    error MintingPaused();

    constructor() {
        // Lock the implementation: only clones (which start uninitialized) can initialize.
        _disableInitializers();
    }

    /// @notice One-time setup, called by the factory in the deploy transaction.
    /// @dev Event order mirrors {OneOfOneImage} with the 1155 sale-stack extensions inserted:
    ///      OwnershipTransferred (owner init) → AbxDeployed → AbxExtensionVersionSet(royalty) →
    ///      RoyaltyChangedForAll → AbxExtensionVersionSet(edition-supply) →
    ///      AbxExtensionVersionSet(external-minter) → [MinterSet] →
    ///      AbxExtensionVersionSet(primary-payee) → [PrimaryPayeeChanged] →
    ///      AbxExtensionVersionSet(paused) → [PausedStatusChanged(true)] →
    ///      AbxExtensionVersionSet(onchain-metadata) → TokenFieldSet*/ContractFieldSet* →
    ///      ContractURIUpdated → (if minting) TransferSingle(0x0, mintTo, 0, mintAmount).
    ///
    ///      The creator-token pair — [AbxExtensionVersionSet(creator-token) →
    ///      TransferValidatorUpdated] — fires LAST of the extension inits, after
    ///      ContractURIUpdated, because enrollment is the only external call here and every
    ///      cap must be written before that reentrancy window opens (see the body).
    function initialize(InitParams calldata p) external initializer {
        _initOwner(p.owner);

        // stored values, no events: token-URI strategy + collection identity
        _initTokenURI(p.tokenURIBase, p.tokenURIRenderer);
        _initCollectionMetadata(p.name, p.symbol);

        // discovery beacon → extensions → contract-URI strategy → mint
        _emitAbxDeployed();
        _initRoyaltyExtension(p.royaltyReceiver, p.royaltyBps, p.maxRoyaltyBps);
        _initBurn(p.burnable);
        _initEditionSupply(p.editionSize);
        _initExternalMinter(p.minter);
        _initPrimaryPayee(p.primaryPayee);
        _initPaused(p.paused);
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

        // mint the deploy-time copies now, or defer entirely (mintTo == 0 or mintAmount == 0).
        if (p.mintTo != address(0) && p.mintAmount != 0) {
            _mintEdition(p.mintTo, p.mintAmount);
        }
    }

    // ── minting ───────────────────────────────────────────────────────────────

    /// @inheritdoc IAbxEditionMint
    /// @dev Reverts unless `id == 0` — the id space is fixed to the single work. Owner always;
    ///      the authorized minter only when unpaused.
    function mint(address to, uint256 id, uint256 amount) external override {
        if (id != TOKEN_ID) revert InvalidTokenId();
        _requireMintAuth();
        _mintEdition(to, amount);
    }

    /// @dev The single choke point for all mint paths: amount guard → cap check → mint.
    function _mintEdition(address to, uint256 amount) internal {
        if (amount == 0) revert ZeroMintAmount();
        _requireWithinEditionCap(TOKEN_ID, amount);
        _mint(to, TOKEN_ID, amount, ""); // TransferSingle(0x0, to, 0, amount)
    }

    /// @dev Mint authorization, composing {Ownable} + {Paused} + {ExternalMinter} — identical
    ///      shape to the 721 twins' `_requireMintAuth`.
    function _requireMintAuth() internal view {
        if (msg.sender == owner()) return; // owner always may (reserves, config, primary sale)
        if (paused()) revert MintingPaused(); // paused ⇒ minter + public blocked
        if (msg.sender != minter()) revert NotMinterOrOwner();
    }

    // ── composition wiring ──────────────────────────────────────────────────--

    /// @dev Compose ERC-165 by OR-ing the base and each mixin that defines supportsInterface.
    ///      (`Uri1155`/`ContractURI` define none — no ERC-4906, and ERC-7572 has no 165 id — so
    ///      they're absent here, exactly like the 721 twin excludes `ContractURI`. `ERC1155` must
    ///      still be named: `Uri1155` inherits it too, via a second path to the same original
    ///      declaration, so Solidity treats it as its own diamond leg — exactly why the 721 twins
    ///      also name `ERC721` here even though `AbxErc721Base` already resolved it once.)
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
            || ExternalMinter.supportsInterface(interfaceId)
            || PrimaryPayee.supportsInterface(interfaceId) || Paused.supportsInterface(interfaceId)
            || interfaceId == type(IAbxEditionMint).interfaceId; // the mint primitive a minter targets
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
    ///      a mint/burn) must pass the validator's policy check before moving. Solady's ERC-1155
    ///      hook is always batch-shaped; {CreatorToken1155} loops it internally.
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
    // The same extraction {EditionCode} and {EditionImage} perform, for the same reason: the ERC-4906
    // refresh emissions pushed this contract under its EIP-170 policy
    // floor, and the floor exists to force exactly this decision rather than be lowered. Access
    // control (`onlyOwner`) stays on these overrides; the library assumes its caller already gated.
    //
    // On the premise that previously kept this contract library-free — that linking one would cost
    // its factory a CREATE2-deterministic address — see the note in {EditionImage}: the broadcast
    // artifacts refute it. Libraries, implementations and factories are each deployed
    // deterministically, so the chain is deterministic end to end; what linking costs is operational
    // (ordering, re-addressing on a library redeploy, a mandatory `--libraries` pin), not
    // determinism.

}
