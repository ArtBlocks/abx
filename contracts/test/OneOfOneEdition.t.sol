// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OneOfOneEdition} from "../src/tokens/OneOfOneEdition.sol";
import {OneOfOneEditionFactory} from "../src/factories/OneOfOneEditionFactory.sol";
import {ExternalMinter} from "../src/extensions/external-minter/ExternalMinter.sol";
import {EditionSupply} from "../src/extensions/edition-supply/EditionSupply.sol";
import {IAbxEditionMint} from "../src/interfaces/IAbxEditionMint.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice Core behavior of a deployed 1/1 edition clone: id space fixed to {0}, the sale-stack
///         mint auth (owner/minter/paused), per-id supply accounting, the Edition Supply cap, and
///         the `uri()` precedence ladder. Mirrors {OneOfOneImageTest}'s scope, generalized to
///         copies.
contract OneOfOneEditionTest is Test {
    // mirrored events for expectEmit
    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 amount
    );
    event MaxSupplyUpdated(uint256 indexed id, uint256 cap);
    event URI(string value, uint256 indexed id);

    OneOfOneEditionFactory internal factory;
    OneOfOneEdition internal nft;

    address internal owner = makeAddr("owner");
    address internal minter = makeAddr("minter");
    address internal collector = makeAddr("collector");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        factory = new OneOfOneEditionFactory();
        nft = OneOfOneEdition(factory.deploy(_params()));
    }

    function _params() internal view returns (OneOfOneEdition.InitParams memory) {
        return OneOfOneEdition.InitParams({
            owner: owner,
            mintTo: owner,
            mintAmount: 3,
            name: "Sunrise",
            symbol: "SUN",
            tokenURIBase: "https://abx.test/t",
            tokenURIRenderer: address(0),
            contractURIBase: "https://abx.test/c",
            contractURIRenderer: address(0),
            royaltyReceiver: owner,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            editionSize: 0,
            primaryPayee: address(0),
            minter: minter,
            paused: false,
            tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    function _derived(address c, uint256 id, string memory base)
        internal
        view
        returns (string memory)
    {
        return string.concat(
            base,
            "/",
            LibString.toString(block.chainid),
            "/",
            LibString.toHexString(c),
            "/",
            LibString.toString(id)
        );
    }

    // ---- initial state ----

    function test_InitialState() public view {
        assertEq(nft.owner(), owner);
        assertEq(nft.balanceOf(owner, 0), 3);
        assertEq(nft.totalSupply(0), 3);
        assertEq(nft.name(), "Sunrise");
        assertEq(nft.symbol(), "SUN");
        assertEq(nft.uri(0), _derived(address(nft), 0, "https://abx.test/t"));
        assertTrue(nft.supportsInterface(type(IAbxEditionMint).interfaceId));
        assertTrue(nft.supportsInterface(0xd9b67a26)); // IERC1155
        assertTrue(nft.supportsInterface(0x0e89341c)); // IERC1155MetadataURI
    }

    function test_DeployWithoutMint_HoldsNoTokens() public {
        OneOfOneEdition.InitParams memory p = _params();
        p.mintTo = address(0);
        p.mintAmount = 0;
        OneOfOneEdition n = OneOfOneEdition(factory.deploy(p));
        assertEq(n.balanceOf(owner, 0), 0);
        assertEq(n.totalSupply(0), 0);
    }

    // ---- minting: id space fixed to {0} ----

    function test_Mint_RevertsInvalidTokenId() public {
        vm.prank(owner);
        vm.expectRevert(OneOfOneEdition.InvalidTokenId.selector);
        nft.mint(collector, 1, 1);
    }

    function test_Mint_RevertsZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(OneOfOneEdition.ZeroMintAmount.selector);
        nft.mint(collector, 0, 0);
    }

    function test_Mint_OwnerAlwaysMay() public {
        vm.expectEmit(true, true, true, true);
        emit TransferSingle(owner, address(0), collector, 0, 2);
        vm.prank(owner);
        nft.mint(collector, 0, 2);
        assertEq(nft.balanceOf(collector, 0), 2);
        assertEq(nft.totalSupply(0), 5);
    }

    function test_Mint_MinterMayWhenUnpaused() public {
        vm.prank(minter);
        nft.mint(collector, 0, 1);
        assertEq(nft.balanceOf(collector, 0), 1);
    }

    function test_Mint_RevertsNotMinterOrOwner() public {
        vm.prank(stranger);
        vm.expectRevert(ExternalMinter.NotMinterOrOwner.selector);
        nft.mint(collector, 0, 1);
    }

    function test_Mint_RevertsWhenPausedForMinter() public {
        vm.prank(owner);
        nft.setPaused(true);
        vm.prank(minter);
        vm.expectRevert(OneOfOneEdition.MintingPaused.selector);
        nft.mint(collector, 0, 1);
    }

    function test_Mint_OwnerBypassesPause() public {
        vm.prank(owner);
        nft.setPaused(true);
        vm.prank(owner);
        nft.mint(collector, 0, 1);
        assertEq(nft.balanceOf(collector, 0), 1);
    }

    // ---- Edition Supply (per-id cap) ----

    function test_EditionSupply_OpenByDefault() public {
        assertEq(nft.maxSupply(0), 0);
        vm.prank(owner);
        nft.mint(collector, 0, 10_000); // no cap -> never reverts on amount alone
        assertEq(nft.totalSupply(0), 10_003);
    }

    function test_EditionSupply_CapEnforced() public {
        OneOfOneEdition.InitParams memory p = _params();
        p.mintTo = address(0);
        p.mintAmount = 0;
        p.editionSize = 5;
        OneOfOneEdition n = OneOfOneEdition(factory.deploy(p));

        vm.prank(owner);
        n.mint(collector, 0, 5); // exactly the cap
        assertEq(n.totalSupply(0), 5);

        vm.prank(owner);
        vm.expectRevert(EditionSupply.EditionSupplyReached.selector);
        n.mint(collector, 0, 1);
    }

    function test_SetMaxSupply_RevertsIncreaseAboveCurrent() public {
        vm.prank(owner);
        nft.setMaxSupply(0, 10);
        vm.prank(owner);
        vm.expectRevert(EditionSupply.MaxSupplyIncreaseForbidden.selector);
        nft.setMaxSupply(0, 11);
    }

    function test_SetMaxSupply_RevertsBelowFloor() public {
        // totalSupply(0) == 3 from the deploy-time mint
        vm.prank(owner);
        vm.expectRevert(EditionSupply.MaxSupplyBelowFloor.selector);
        nft.setMaxSupply(0, 2);
    }

    function test_SetMaxSupply_MonotonicChainDownToFloor() public {
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, true);
        emit MaxSupplyUpdated(0, 10);
        nft.setMaxSupply(0, 10);
        nft.setMaxSupply(0, 5);
        nft.setMaxSupply(0, 3); // == current totalSupply(0), closes the edition
        vm.stopPrank();
        assertEq(nft.maxSupply(0), 3);

        vm.prank(owner);
        vm.expectRevert(EditionSupply.EditionSupplyReached.selector);
        nft.mint(collector, 0, 1);
    }

    // ---- regression: the four monotonicity states {un-overridden × overridden} × {open × closed} ----

    /// State 1: un-overridden, default `0` (open) — ANY cap is a decrease off "unbounded".
    function test_SetMaxSupply_UnoverriddenOpenDefault_AnyCapAllowed() public {
        assertEq(nft.maxSupply(0), 0); // never overridden, default cap 0
        vm.prank(owner);
        nft.setMaxSupply(0, 1_000_000); // huge relative to totalSupply(0) == 3, still a "decrease"
        assertEq(nft.maxSupply(0), 1_000_000);
    }

    /// State 2: un-overridden, non-zero default — the first override may not exceed it.
    function test_SetMaxSupply_UnoverriddenNonzeroDefault_CapMustNotExceedDefault() public {
        OneOfOneEdition.InitParams memory p = _params();
        p.mintTo = address(0);
        p.mintAmount = 0;
        p.editionSize = 10;
        OneOfOneEdition n = OneOfOneEdition(factory.deploy(p));

        vm.prank(owner);
        vm.expectRevert(EditionSupply.MaxSupplyIncreaseForbidden.selector);
        n.setMaxSupply(0, 11); // above the un-overridden default

        vm.prank(owner);
        n.setMaxSupply(0, 10); // == default, allowed (not an increase)
        assertEq(n.maxSupply(0), 10);
    }

    /// State 4, and the bug this test guards against: an id explicitly closed to `0` reads
    /// `maxSupply(id) == 0`, identically to an un-overridden open id — but it is NOT open. A
    /// later `setMaxSupply(id, 5)` must revert, never reopen it.
    function test_SetMaxSupply_ClosedIdCannotBeReopened() public {
        OneOfOneEdition.InitParams memory p = _params();
        p.mintTo = address(0);
        p.mintAmount = 0; // totalSupply(0) == 0, so closing to cap 0 is legal
        OneOfOneEdition n = OneOfOneEdition(factory.deploy(p));

        vm.prank(owner);
        n.setMaxSupply(0, 0); // permanently closed
        assertEq(n.maxSupply(0), 0);

        vm.prank(owner);
        vm.expectRevert(EditionSupply.MaxSupplyIncreaseForbidden.selector);
        n.setMaxSupply(0, 5); // THE REOPEN BUG — must revert, not reopen

        vm.prank(owner);
        n.setMaxSupply(0, 0); // the only value ever legal again: 0 itself
        assertEq(n.maxSupply(0), 0);
    }

    // ---- supply accounting across transfers ----

    function test_SupplyUnaffectedByHolderToHolderTransfer() public {
        vm.prank(owner);
        nft.safeTransferFrom(owner, collector, 0, 3, "");
        assertEq(nft.totalSupply(0), 3); // unchanged — no mint/burn happened
        assertEq(nft.balanceOf(collector, 0), 3);
        assertEq(nft.balanceOf(owner, 0), 0);
    }
}
