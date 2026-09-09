// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {AbxFixedPriceMinter} from "../src/minters/AbxFixedPriceMinter.sol";
import {SeriesImage} from "../src/tokens/SeriesImage.sol";
import {SeriesImageFactory} from "../src/factories/SeriesImageFactory.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {ExternalMinter} from "../src/extensions/external-minter/ExternalMinter.sol";
import {MaxInvocations} from "../src/extensions/max-invocations/MaxInvocations.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Minimal ERC-20 for the paid-in-token path.
contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MOCK";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A payee that re-enters the minter on ETH receipt — the reentrancy probe.
contract ReentrantPayee {
    AbxFixedPriceMinter internal immutable minter;
    address internal immutable token;

    constructor(AbxFixedPriceMinter m, address t) {
        minter = m;
        token = t;
    }

    receive() external payable {
        // try to buy again mid-forward; the guard must block it (whole purchase reverts)
        minter.purchase{value: msg.value}(token, address(0), msg.value);
    }
}

/// @notice The reference fixed-price minter: config defers to the token owner, one mint per call,
///         ETH/ERC-20 payment routed to the token's primaryPayee, allocation vs. cap, pause as the
///         on/off switch, multi-tenant isolation, the buyer's slippage guard against a mid-flight
///         `configure`, and the Minter spine events.
contract AbxFixedPriceMinterTest is Test {
    SeriesImageFactory internal factory;
    AbxFixedPriceMinter internal fpm;
    SeriesImage internal nft;
    MockERC20 internal erc20;

    address internal owner = makeAddr("owner");
    address internal payee = makeAddr("payee");
    address internal buyer = makeAddr("buyer");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant N = 5; // series size (token cap)
    uint256 internal constant PRICE = 0.1 ether;

    // mirrored Minter spine events
    event SaleConfigured(
        address indexed token, address paymentToken, uint256 price, uint256 allocation
    );
    event Purchase(
        address indexed token,
        address indexed buyer,
        address indexed to,
        uint256 tokenId,
        address paymentToken,
        uint256 price
    );

    function setUp() public {
        factory = new SeriesImageFactory();
        fpm = new AbxFixedPriceMinter();
        erc20 = new MockERC20();
        nft = _deploy(payee, address(fpm), false); // payee set, minter = fpm, unpaused
    }

    // ---- helpers ----

    function _deploy(address primaryPayee, address minter, bool paused)
        internal
        returns (SeriesImage)
    {
        SeriesImage.InitParams memory p = SeriesImage.InitParams({
            owner: owner,
            name: "Postcards",
            symbol: "PC",
            tokenURIBase: "https://abx.test/t",
            tokenURIRenderer: address(0),
            contractURIBase: "https://abx.test/c",
            contractURIRenderer: address(0),
            royaltyReceiver: owner,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            maxInvocations: N,
            primaryPayee: primaryPayee,
            minter: minter,
            paused: paused,
            mintTo: address(0),
            mintCount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
        return SeriesImage(factory.deploy(p));
    }

    function _sold(address token) internal view returns (uint256 sold) {
        (,,,, sold) = fpm.sales(token);
    }

    // ---- configuration (defers to token owner) ----

    function test_Configure_OnlyProjectOwner() public {
        vm.prank(stranger);
        vm.expectRevert(AbxFixedPriceMinter.NotProjectOwner.selector);
        fpm.configure(address(nft), address(0), PRICE, N);
    }

    function test_Configure_OwnerSets_Emits() public {
        vm.expectEmit(true, false, false, true);
        emit SaleConfigured(address(nft), address(0), PRICE, N);
        vm.prank(owner);
        fpm.configure(address(nft), address(0), PRICE, N);

        (bool configured, address paymentToken, uint256 price, uint256 allocation, uint256 sold) =
            fpm.sales(address(nft));
        assertTrue(configured);
        assertEq(paymentToken, address(0));
        assertEq(price, PRICE);
        assertEq(allocation, N);
        assertEq(sold, 0);
    }

    function test_Configure_RevertsAllocationBelowSold() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(0), PRICE, N);
        vm.deal(buyer, PRICE * 2);
        vm.startPrank(buyer);
        fpm.purchase{value: PRICE}(address(nft), address(0), PRICE);
        fpm.purchase{value: PRICE}(address(nft), address(0), PRICE); // sold = 2
        vm.stopPrank();

        vm.prank(owner);
        vm.expectRevert(AbxFixedPriceMinter.AllocationBelowSold.selector);
        fpm.configure(address(nft), address(0), PRICE, 1); // below sold (2)
    }

    // ---- purchase: ETH ----

    function test_Purchase_ETH_MintsAndForwards() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(0), PRICE, N);
        vm.deal(buyer, PRICE);

        vm.expectEmit(true, true, true, true);
        emit Purchase(address(nft), buyer, buyer, 0, address(0), PRICE);
        vm.prank(buyer);
        uint256 id = fpm.purchase{value: PRICE}(address(nft), address(0), PRICE);

        assertEq(id, 0);
        assertEq(nft.ownerOf(0), buyer);
        assertEq(payee.balance, PRICE); // proceeds routed to primaryPayee
        assertEq(address(fpm).balance, 0); // minter custodies nothing
        assertEq(_sold(address(nft)), 1);
    }

    function test_PurchaseTo_ETH_MintsToRecipient() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(0), PRICE, N);
        vm.deal(buyer, PRICE);

        vm.expectEmit(true, true, true, true);
        emit Purchase(address(nft), buyer, recipient, 0, address(0), PRICE);
        vm.prank(buyer);
        fpm.purchaseTo{value: PRICE}(address(nft), recipient, address(0), PRICE);

        assertEq(nft.ownerOf(0), recipient);
        assertEq(payee.balance, PRICE);
    }

    function test_Purchase_SequentialIds() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(0), PRICE, N);
        vm.deal(buyer, PRICE * 3);
        vm.startPrank(buyer);
        assertEq(fpm.purchase{value: PRICE}(address(nft), address(0), PRICE), 0);
        assertEq(fpm.purchase{value: PRICE}(address(nft), address(0), PRICE), 1);
        assertEq(fpm.purchase{value: PRICE}(address(nft), address(0), PRICE), 2);
        vm.stopPrank();
        assertEq(payee.balance, PRICE * 3);
    }

    function test_Purchase_RevertsNotConfigured() public {
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter.NotConfigured.selector);
        fpm.purchase{value: PRICE}(address(nft), address(0), PRICE);
    }

    function test_Purchase_ETH_RevertsWrongValue() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(0), PRICE, N);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter.WrongPayment.selector);
        fpm.purchase{value: PRICE - 1}(address(nft), address(0), PRICE); // underpay
    }

    function test_Purchase_FreeMint_ZeroPrice() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(0), 0, N); // free
        vm.prank(buyer);
        uint256 id = fpm.purchase{value: 0}(address(nft), address(0), 0);
        assertEq(id, 0);
        assertEq(nft.ownerOf(0), buyer);
        assertEq(payee.balance, 0);
    }

    // ---- purchase: ERC-20 ----

    function test_Purchase_ERC20_PullsToPayee() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE);
        vm.prank(buyer);
        erc20.approve(address(fpm), PRICE);

        vm.expectEmit(true, true, true, true);
        emit Purchase(address(nft), buyer, buyer, 0, address(erc20), PRICE);
        vm.prank(buyer);
        fpm.purchase(address(nft), address(erc20), PRICE); // no msg.value

        assertEq(erc20.balanceOf(payee), PRICE); // buyer → payee, non-custodial
        assertEq(erc20.balanceOf(buyer), 0);
        assertEq(erc20.balanceOf(address(fpm)), 0);
        assertEq(nft.ownerOf(0), buyer);
    }

    function test_Purchase_ERC20_RevertsIfETHSent() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE);
        vm.prank(buyer);
        erc20.approve(address(fpm), PRICE);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter.WrongPayment.selector);
        fpm.purchase{value: 1}(address(nft), address(erc20), PRICE);
    }

    // ---- the buyer's slippage guard (configure() takes effect immediately) ----

    function test_Purchase_ExactAdvertisedTerms_Succeeds() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE);
        vm.startPrank(buyer);
        erc20.approve(address(fpm), PRICE);
        fpm.purchase(address(nft), address(erc20), PRICE); // exactly the terms on offer
        vm.stopPrank();

        assertEq(nft.ownerOf(0), buyer);
        assertEq(erc20.balanceOf(payee), PRICE);
    }

    function test_Purchase_OwnerFrontRunsPrice_RevertsAndAllowanceUntouched() public {
        // The theft path the guard closes: an ERC-20 sale settles `safeTransferFrom(buyer, payee,
        // price)` against a STANDING allowance, so an unbounded price spends whatever was approved.
        vm.prank(owner);
        fpm.configure(address(nft), address(erc20), PRICE, N);
        erc20.mint(buyer, 100 * PRICE);
        vm.prank(buyer);
        erc20.approve(address(fpm), 100 * PRICE); // approve-once, the common wallet pattern

        // the owner front-runs the pending purchase with a price that would drain the allowance
        vm.prank(owner);
        fpm.configure(address(nft), address(erc20), 100 * PRICE, N);

        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter.SaleTermsChanged.selector);
        fpm.purchase(address(nft), address(erc20), PRICE); // bounded at the advertised price

        assertEq(erc20.balanceOf(buyer), 100 * PRICE); // not one unit moved
        assertEq(erc20.balanceOf(payee), 0);
        assertEq(nft.totalSupply(), 0);
    }

    function test_Purchase_OwnerSwitchesPaymentToken_Reverts() public {
        // The sibling case: switch the sale to a *different* ERC-20 the buyer approved elsewhere.
        MockERC20 other = new MockERC20();
        vm.prank(owner);
        fpm.configure(address(nft), address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE);
        other.mint(buyer, PRICE);
        vm.startPrank(buyer);
        erc20.approve(address(fpm), PRICE);
        other.approve(address(fpm), PRICE); // a standing approval left over from some other sale
        vm.stopPrank();

        vm.prank(owner);
        fpm.configure(address(nft), address(other), PRICE, N);

        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter.SaleTermsChanged.selector);
        fpm.purchase(address(nft), address(erc20), PRICE);

        assertEq(other.balanceOf(buyer), PRICE); // the other allowance is untouched
        assertEq(nft.totalSupply(), 0);
    }

    function test_Purchase_PriceDecrease_UnderMax_Succeeds() public {
        // The guard is a ceiling, not an equality — a price CUT still settles, at the new price.
        vm.prank(owner);
        fpm.configure(address(nft), address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE);
        vm.prank(buyer);
        erc20.approve(address(fpm), PRICE);

        vm.prank(owner);
        fpm.configure(address(nft), address(erc20), PRICE / 2, N); // owner cuts the price

        vm.prank(buyer);
        fpm.purchase(address(nft), address(erc20), PRICE); // still bounded by the price they read

        assertEq(erc20.balanceOf(payee), PRICE / 2); // only the live price moved
        assertEq(erc20.balanceOf(buyer), PRICE / 2);
        assertEq(nft.ownerOf(0), buyer);
    }

    function test_Purchase_ETH_PriceDecrease_NeedsTheNewExactValue() public {
        // On the ETH lane the bound is not the only constraint: exact payment still binds, so a
        // buyer who bounded at the old price must still attach the NEW one.
        vm.startPrank(owner);
        fpm.configure(address(nft), address(0), PRICE, N);
        fpm.configure(address(nft), address(0), PRICE / 2, N); // cut, mid-flight
        vm.stopPrank();
        vm.deal(buyer, PRICE * 2);

        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter.WrongPayment.selector);
        fpm.purchase{value: PRICE}(address(nft), address(0), PRICE); // over-pays the cut price

        vm.prank(buyer);
        fpm.purchase{value: PRICE / 2}(address(nft), address(0), PRICE); // bound survives the cut
        assertEq(nft.ownerOf(0), buyer);
        assertEq(payee.balance, PRICE / 2);
    }

    // ---- allocation vs. the token cap ----

    function test_Purchase_RevertsAllocationExhausted() public {
        vm.prank(owner);
        fpm.configure(address(nft), address(0), PRICE, 2); // budget of 2 (< N)
        vm.deal(buyer, PRICE * 3);
        vm.startPrank(buyer);
        fpm.purchase{value: PRICE}(address(nft), address(0), PRICE);
        fpm.purchase{value: PRICE}(address(nft), address(0), PRICE);
        vm.expectRevert(AbxFixedPriceMinter.AllocationExhausted.selector);
        fpm.purchase{value: PRICE}(address(nft), address(0), PRICE); // 3rd exceeds this minter's allocation
        vm.stopPrank();
    }

    function test_Purchase_RespectsTokenCap_TighterBinds() public {
        // allocation exceeds N; the token's own maxInvocations cap binds first.
        vm.prank(owner);
        fpm.configure(address(nft), address(0), PRICE, N + 100);
        vm.deal(buyer, PRICE * (N + 1));
        vm.startPrank(buyer);
        for (uint256 i; i < N; ++i) {
            fpm.purchase{value: PRICE}(address(nft), address(0), PRICE);
        }
        vm.expectRevert(MaxInvocations.MaxInvocationsReached.selector);
        fpm.purchase{value: PRICE}(address(nft), address(0), PRICE);
        vm.stopPrank();
    }

    // ---- deferring to the token: payee, pause, minter assignment ----

    function test_Purchase_RevertsNoPrimaryPayee() public {
        SeriesImage noPayee = _deploy(address(0), address(fpm), false);
        vm.prank(owner);
        fpm.configure(address(noPayee), address(0), PRICE, N);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter.NoPrimaryPayee.selector);
        fpm.purchase{value: PRICE}(address(noPayee), address(0), PRICE);
    }

    function test_Purchase_RevertsWhenPaused_ThenOpensOnUnpause() public {
        SeriesImage paused = _deploy(payee, address(fpm), true);
        vm.prank(owner);
        fpm.configure(address(paused), address(0), PRICE, N);
        vm.deal(buyer, PRICE * 2);

        // paused ⇒ the token rejects the minter's mint → purchase bubbles the revert
        vm.prank(buyer);
        vm.expectRevert(SeriesImage.MintingPaused.selector);
        fpm.purchase{value: PRICE}(address(paused), address(0), PRICE);

        // owner unpauses = opens the sale
        vm.prank(owner);
        paused.setPaused(false);
        vm.prank(buyer);
        fpm.purchase{value: PRICE}(address(paused), address(0), PRICE);
        assertEq(paused.ownerOf(0), buyer);
    }

    function test_Purchase_RevertsWhenMinterNotAssigned() public {
        // configured sale, but the owner never granted mint rights on the token.
        SeriesImage unassigned = _deploy(payee, address(0), false);
        vm.prank(owner);
        fpm.configure(address(unassigned), address(0), PRICE, N);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        vm.expectRevert(ExternalMinter.NotMinterOrOwner.selector);
        fpm.purchase{value: PRICE}(address(unassigned), address(0), PRICE);
    }

    // ---- multi-tenant isolation ----

    function test_MultiTenant_IsolatedSales() public {
        SeriesImage other = _deploy(payee, address(fpm), false);
        vm.startPrank(owner);
        fpm.configure(address(nft), address(0), PRICE, N);
        fpm.configure(address(other), address(erc20), 2 * PRICE, 3);
        vm.stopPrank();

        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        fpm.purchase{value: PRICE}(address(nft), address(0), PRICE);

        assertEq(_sold(address(nft)), 1);
        assertEq(_sold(address(other)), 0); // untouched
        (, address pt,, uint256 alloc,) = fpm.sales(address(other));
        assertEq(pt, address(erc20));
        assertEq(alloc, 3);
    }

    // ---- reentrancy ----

    function test_Purchase_ReentrantPayeeReverts() public {
        ReentrantPayee attacker = new ReentrantPayee(fpm, address(nft));
        SeriesImage evil = _deploy(address(attacker), address(fpm), false);
        vm.prank(owner);
        fpm.configure(address(evil), address(0), PRICE, N);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        vm.expectRevert(); // ETH forward re-enters purchase → guard trips → whole tx reverts
        fpm.purchase{value: PRICE}(address(evil), address(0), PRICE);
        assertEq(evil.totalSupply(), 0); // nothing minted
    }
}
