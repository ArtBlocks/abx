// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {ERC721} from "solady/tokens/ERC721.sol";

import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {OneOfOneEdition} from "../src/tokens/OneOfOneEdition.sol";
import {OneOfOneEditionFactory} from "../src/factories/OneOfOneEditionFactory.sol";
import {AbxErc721Base} from "../src/core/AbxErc721Base.sol";
import {AbxErc1155Base} from "../src/core/AbxErc1155Base.sol";
import {RoyaltyExtension} from "../src/extensions/royalty/RoyaltyExtension.sol";
import {IAbxRoyalty} from "../src/extensions/royalty/IAbxRoyalty.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice Opt-in burn and owner-set, reduce-only royalty caps. Burn is verified opt-in (default
///         off), holder-or-approved,
///         supply-decrementing, and metadata-not-resolving-after; the cap is verified owner-set at
///         deploy, reduce-only, and never droppable below the live royalty.
contract BurnAndRoyaltyCapTest is Test {
    OneOfOneImageFactory internal factory;
    OneOfOneEditionFactory internal editionFactory;

    address internal owner = makeAddr("owner");
    address internal holder = makeAddr("holder");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        factory = new OneOfOneImageFactory();
        editionFactory = new OneOfOneEditionFactory();
    }

    function _deploy721(bool burnable, uint16 royaltyBps, uint16 maxRoyaltyBps)
        internal
        returns (OneOfOneImage)
    {
        return OneOfOneImage(
            factory.deploy(
                OneOfOneImage.InitParams({
                    owner: owner,
                    mintTo: holder,
                    name: "One",
                    symbol: "ONE",
                    tokenURIBase: "https://abx.test/t",
                    tokenURIRenderer: address(0),
                    contractURIBase: "https://abx.test/c",
                    contractURIRenderer: address(0),
                    royaltyReceiver: owner,
                    royaltyBps: royaltyBps,
                    maxRoyaltyBps: maxRoyaltyBps,
                    burnable: burnable,
                    transferValidator: address(0),
                    tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
                    contractFields: new IAbxOnChainMetadata.FieldInput[](0)
                })
            )
        );
    }

    function _deployEdition(bool burnable) internal returns (OneOfOneEdition) {
        return OneOfOneEdition(
            editionFactory.deploy(
                OneOfOneEdition.InitParams({
                    owner: owner,
                    mintTo: holder,
                    mintAmount: 5,
                    name: "Ed",
                    symbol: "ED",
                    tokenURIBase: "https://abx.test/t",
                    tokenURIRenderer: address(0),
                    contractURIBase: "https://abx.test/c",
                    contractURIRenderer: address(0),
                    royaltyReceiver: owner,
                    royaltyBps: 500,
                    maxRoyaltyBps: 1000,
                    burnable: burnable,
                    transferValidator: address(0),
                    editionSize: 0,
                    primaryPayee: address(0),
                    minter: address(0),
                    paused: false,
                    tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
                    contractFields: new IAbxOnChainMetadata.FieldInput[](0)
                })
            )
        );
    }

    // ── opt-in burn ─────────────────────────────────────────────────────────--

    function test_Burn_DisabledByDefault() public {
        OneOfOneImage nft = _deploy721(false, 500, 1000);
        assertFalse(nft.burnable());
        vm.prank(holder);
        vm.expectRevert(AbxErc721Base.BurnDisabled.selector);
        nft.burn(0);
        assertEq(nft.totalSupply(), 1); // untouched
    }

    function test_Burn_HolderCanBurnWhenEnabled_SupplyDecrements() public {
        OneOfOneImage nft = _deploy721(true, 500, 1000);
        assertTrue(nft.burnable());
        assertEq(nft.totalSupply(), 1);
        vm.prank(holder);
        nft.burn(0);
        assertEq(nft.totalSupply(), 0);
        // ERC-721: the token no longer exists → ownerOf reverts.
        vm.expectRevert();
        nft.ownerOf(0);
    }

    function test_Burn_MetadataStopsResolvingAfterBurn() public {
        OneOfOneImage nft = _deploy721(true, 500, 1000);
        nft.tokenURI(0); // resolves before
        vm.prank(holder);
        nft.burn(0);
        vm.expectRevert(); // NonexistentToken — metadata deliberately does not resolve post-burn
        nft.tokenURI(0);
    }

    function test_Burn_NonHolderCannotBurn() public {
        OneOfOneImage nft = _deploy721(true, 500, 1000);
        vm.prank(stranger);
        vm.expectRevert(); // Solady _burn(by, id): NotOwnerNorApproved
        nft.burn(0);
        assertEq(nft.totalSupply(), 1);
    }

    function test_Burn_OwnerWithoutTokenCannotBurn() public {
        // No owner bypass: even the collection owner must hold or be approved for the token.
        OneOfOneImage nft = _deploy721(true, 500, 1000);
        vm.prank(owner);
        vm.expectRevert();
        nft.burn(0);
        assertEq(nft.totalSupply(), 1);
    }

    function test_Burn_ApprovedOperatorCanBurn() public {
        OneOfOneImage nft = _deploy721(true, 500, 1000);
        vm.prank(holder);
        nft.setApprovalForAll(stranger, true);
        vm.prank(stranger);
        nft.burn(0);
        assertEq(nft.totalSupply(), 0);
    }

    function test_Burn_Edition1155_HolderBurnsAmount() public {
        OneOfOneEdition ed = _deployEdition(true);
        assertTrue(ed.burnable());
        assertEq(ed.balanceOf(holder, 0), 5);
        vm.prank(holder);
        ed.burn(holder, 0, 2);
        assertEq(ed.balanceOf(holder, 0), 3);
    }

    function test_Burn_Edition1155_DisabledByDefault() public {
        OneOfOneEdition ed = _deployEdition(false);
        vm.prank(holder);
        vm.expectRevert(AbxErc1155Base.BurnDisabled.selector);
        ed.burn(holder, 0, 1);
    }

    function test_Burn_Edition1155_NonHolderCannotBurnOthers() public {
        OneOfOneEdition ed = _deployEdition(true);
        vm.prank(stranger);
        vm.expectRevert(); // not owner nor approved operator of `holder`
        ed.burn(holder, 0, 1);
    }

    // ── owner-set, reduce-only royalty cap ──────────────────────────────────--

    function test_RoyaltyCap_OwnerSetsUpTo100Percent() public {
        OneOfOneImage nft = _deploy721(false, 4200, 4200);
        assertEq(nft.maxRoyaltyBps(), 4200);
        (, uint256 amount) = nft.royaltyInfo(0, 10_000);
        assertEq(amount, 4200); // 42% honored — above the old hard 10% ceiling
    }

    function test_RoyaltyCap_RoyaltyAboveCapReverts() public {
        vm.expectRevert(RoyaltyExtension.RoyaltyTooHigh.selector);
        _deploy721(false, 4300, 4200); // royalty 43% > cap 42%
    }

    function test_RoyaltyCap_InitCapAbove100PercentReverts() public {
        vm.expectRevert(RoyaltyExtension.RoyaltyCapAboveMax.selector);
        _deploy721(false, 0, 10_001);
    }

    function test_RoyaltyCap_ReduceOnly() public {
        OneOfOneImage nft = _deploy721(false, 1000, 5000);
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit IAbxRoyalty.MaxRoyaltyBpsUpdated(2000);
        nft.reduceMaxRoyaltyBps(2000);
        assertEq(nft.maxRoyaltyBps(), 2000);

        // cannot raise it again
        vm.prank(owner);
        vm.expectRevert(RoyaltyExtension.RoyaltyCapNotReduced.selector);
        nft.reduceMaxRoyaltyBps(3000);

        // cannot no-op it either (must strictly decrease)
        vm.prank(owner);
        vm.expectRevert(RoyaltyExtension.RoyaltyCapNotReduced.selector);
        nft.reduceMaxRoyaltyBps(2000);
    }

    function test_RoyaltyCap_CannotReduceBelowCurrentRoyalty() public {
        OneOfOneImage nft = _deploy721(false, 1000, 5000); // 10% royalty, 50% cap
        vm.prank(owner);
        vm.expectRevert(RoyaltyExtension.RoyaltyCapBelowRoyalty.selector);
        nft.reduceMaxRoyaltyBps(900); // below the live 1000 bps royalty

        // lower the royalty first, THEN the cap can follow
        vm.prank(owner);
        nft.setDefaultRoyalty(owner, 800);
        vm.prank(owner);
        nft.reduceMaxRoyaltyBps(900); // now allowed
        assertEq(nft.maxRoyaltyBps(), 900);
    }

    function test_RoyaltyCap_ReduceIsOwnerOnly() public {
        OneOfOneImage nft = _deploy721(false, 1000, 5000);
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.reduceMaxRoyaltyBps(2000);
    }

    // ── the extraction: owner gate moved into AbxParamsLib, still enforced ───--
    // The full param/schema/configure suites (SeriesCode.t.sol, ParamsEnumeration.t.sol,
    // SeedAndCapInvariants.t.sol) already exercise the extracted write paths; the burn/royalty
    // additions above cover the new surface. The extraction's owner gate is mutation-verified
    // there (a stranger raw write reverts `Unauthorized`, a schema'd key reverts `SchemaGoverned`).
}
