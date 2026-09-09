// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {AbxFixedPriceMinter1155} from "../src/minters/AbxFixedPriceMinter1155.sol";
import {EditionImage} from "../src/tokens/EditionImage.sol";
import {EditionImageFactory} from "../src/factories/EditionImageFactory.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Minimal ERC-20 for the paid-in-token path.
contract MockERC20_1155 is ERC20 {
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
contract ReentrantPayee1155 {
    AbxFixedPriceMinter1155 internal immutable minter;
    address internal immutable token;
    uint256 internal immutable id;

    constructor(AbxFixedPriceMinter1155 m, address t, uint256 tokenId) {
        minter = m;
        token = t;
        id = tokenId;
    }

    receive() external payable {
        minter.purchase{value: msg.value}(token, id, 1, address(0), msg.value);
    }
}

/// @dev A mint recipient that re-enters the minter from the ERC-1155 receiver callback. This is a
///      DIFFERENT vector from {ReentrantPayee1155}: Solady's `_mint` fires `onERC1155Received` when
///      the recipient is a contract (standard-mandated on 1155, no 721 analogue), so it runs mid-mint,
///      after `sold += qty` and payment collection. The ReentrancyGuard must cover it too.
contract ReentrantReceiver1155 {
    AbxFixedPriceMinter1155 internal immutable minter;
    address internal token;
    uint256 internal id;

    constructor(AbxFixedPriceMinter1155 m) {
        minter = m;
    }

    function arm(address t, uint256 tokenId) external {
        token = t;
        id = tokenId;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        minter.purchase{value: 0}(token, id, 1, address(0), 0); // re-enter — must revert
        return this.onERC1155Received.selector;
    }
}

/// @notice The edition fixed-price minter: `(token, id)`-keyed sales, config defers to the token
///         owner, `qty` copies per call, ETH/ERC-20 payment routed to `primaryPayee`, allocation
///         vs. the token's own per-id cap, pause as the on/off switch, per-id isolation, and the
///         buyer's slippage guard (bounding the *total*, so `qty` is inside the bound).
///         Mirrors {AbxFixedPriceMinterTest}'s scope, generalized to quantity.
contract AbxFixedPriceMinter1155Test is Test {
    EditionImageFactory internal factory;
    AbxFixedPriceMinter1155 internal fpm;
    EditionImage internal nft;
    MockERC20_1155 internal erc20;

    address internal owner = makeAddr("owner");
    address internal payee = makeAddr("payee");
    address internal buyer = makeAddr("buyer");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant N = 5; // id-space cap
    uint256 internal constant PRICE = 0.1 ether;
    uint256 internal constant ID = 0;

    event SaleConfigured(
        address indexed token,
        uint256 indexed id,
        address paymentToken,
        uint256 price,
        uint256 allocation
    );
    event Purchase(
        address indexed token,
        address indexed buyer,
        address indexed to,
        uint256 id,
        uint256 amount,
        address paymentToken,
        uint256 price
    );

    function setUp() public {
        factory = new EditionImageFactory();
        fpm = new AbxFixedPriceMinter1155();
        erc20 = new MockERC20_1155();
        nft = _deploy(payee, address(fpm), false);
    }

    function _deploy(address primaryPayee, address minter, bool paused)
        internal
        returns (EditionImage)
    {
        EditionImage.InitParams memory p = EditionImage.InitParams({
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
            editionSize: 0,
            primaryPayee: primaryPayee,
            minter: minter,
            paused: paused,
            mintTo: address(0),
            mintCount: 0,
            mintAmount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
        return EditionImage(factory.deploy(p));
    }

    function _sold(address token, uint256 id) internal view returns (uint256 sold) {
        (,,,, sold) = fpm.sales(token, id);
    }

    // ---- configuration (defers to token owner) ----

    function test_Configure_OnlyProjectOwner() public {
        vm.prank(stranger);
        vm.expectRevert(AbxFixedPriceMinter1155.NotProjectOwner.selector);
        fpm.configure(address(nft), ID, address(0), PRICE, N);
    }

    function test_Configure_OwnerSets_Emits() public {
        vm.expectEmit(true, true, false, true);
        emit SaleConfigured(address(nft), ID, address(0), PRICE, N);
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(0), PRICE, N);

        (bool configured, address paymentToken, uint256 price, uint256 allocation, uint256 sold) =
            fpm.sales(address(nft), ID);
        assertTrue(configured);
        assertEq(paymentToken, address(0));
        assertEq(price, PRICE);
        assertEq(allocation, N);
        assertEq(sold, 0);
    }

    function test_Configure_RevertsAllocationBelowSold() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(0), PRICE, N);
        vm.deal(buyer, PRICE * 2);
        vm.startPrank(buyer);
        fpm.purchase{value: PRICE * 2}(address(nft), ID, 2, address(0), PRICE * 2); // sold = 2
        vm.stopPrank();

        vm.prank(owner);
        vm.expectRevert(AbxFixedPriceMinter1155.AllocationBelowSold.selector);
        fpm.configure(address(nft), ID, address(0), PRICE, 1);
    }

    // ---- purchase: ETH ----

    function test_Purchase_ETH_MintsQuantityAndForwards() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(0), PRICE, N);
        vm.deal(buyer, PRICE * 3);

        vm.expectEmit(true, true, true, true);
        emit Purchase(address(nft), buyer, buyer, ID, 3, address(0), PRICE);
        vm.prank(buyer);
        fpm.purchase{value: PRICE * 3}(address(nft), ID, 3, address(0), PRICE * 3);

        assertEq(nft.balanceOf(buyer, ID), 3);
        assertEq(payee.balance, PRICE * 3);
        assertEq(address(fpm).balance, 0);
        assertEq(_sold(address(nft), ID), 3);
    }

    function test_PurchaseTo_ETH_MintsToRecipient() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(0), PRICE, N);
        vm.deal(buyer, PRICE);

        vm.expectEmit(true, true, true, true);
        emit Purchase(address(nft), buyer, recipient, ID, 1, address(0), PRICE);
        vm.prank(buyer);
        fpm.purchaseTo{value: PRICE}(address(nft), ID, 1, recipient, address(0), PRICE);

        assertEq(nft.balanceOf(recipient, ID), 1);
        assertEq(payee.balance, PRICE);
    }

    function test_Purchase_RevertsZeroQuantity() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(0), PRICE, N);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter1155.ZeroQuantity.selector);
        fpm.purchase(address(nft), ID, 0, address(0), 0);
    }

    function test_Purchase_RevertsNotConfigured() public {
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter1155.NotConfigured.selector);
        fpm.purchase{value: PRICE}(address(nft), ID, 1, address(0), PRICE);
    }

    function test_Purchase_ETH_RevertsWrongValue() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(0), PRICE, N);
        vm.deal(buyer, PRICE * 2);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter1155.WrongPayment.selector);
        fpm.purchase{value: PRICE}(address(nft), ID, 2, address(0), PRICE * 2); // underpay for qty 2
    }

    function test_Purchase_FreeMint_ZeroPrice() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(0), 0, N);
        vm.prank(buyer);
        fpm.purchase{value: 0}(address(nft), ID, 4, address(0), 0);
        assertEq(nft.balanceOf(buyer, ID), 4);
        assertEq(payee.balance, 0);
    }

    function test_Purchase_RevertsAllocationExhausted() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(0), PRICE, 3); // allocation 3
        vm.deal(buyer, PRICE * 4);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter1155.AllocationExhausted.selector);
        fpm.purchase{value: PRICE * 4}(address(nft), ID, 4, address(0), PRICE * 4); // exceeds allocation in one call
    }

    function test_Purchase_RevertsNoPrimaryPayee() public {
        EditionImage n = _deploy(address(0), address(fpm), false); // no payee
        vm.prank(owner);
        fpm.configure(address(n), ID, address(0), PRICE, N);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter1155.NoPrimaryPayee.selector);
        fpm.purchase{value: PRICE}(address(n), ID, 1, address(0), PRICE);
    }

    function test_Purchase_RevertsWhenTokenPaused() public {
        EditionImage n = _deploy(payee, address(fpm), true); // deployed paused
        vm.prank(owner);
        fpm.configure(address(n), ID, address(0), PRICE, N);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        // paused blocks the minter (and everyone but the owner) before the minter identity even
        // matters — same precedence as the 721 twin's `_requireMintAuth`.
        vm.expectRevert(EditionImage.MintingPaused.selector);
        fpm.purchase{value: PRICE}(address(n), ID, 1, address(0), PRICE);
    }

    // ---- purchase: ERC-20 ----

    function test_Purchase_ERC20_PullsQuantityPriceToPayee() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE * 2);
        vm.prank(buyer);
        erc20.approve(address(fpm), PRICE * 2);

        vm.expectEmit(true, true, true, true);
        emit Purchase(address(nft), buyer, buyer, ID, 2, address(erc20), PRICE);
        vm.prank(buyer);
        fpm.purchase(address(nft), ID, 2, address(erc20), PRICE * 2); // no msg.value

        assertEq(erc20.balanceOf(payee), PRICE * 2);
        assertEq(nft.balanceOf(buyer, ID), 2);
    }

    function test_Purchase_ERC20_RevertsIfEthSent() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        erc20.approve(address(fpm), PRICE);
        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter1155.WrongPayment.selector);
        fpm.purchase{value: PRICE}(address(nft), ID, 1, address(erc20), PRICE);
    }

    // ---- the buyer's slippage guard (configure() takes effect immediately) ----

    function test_Purchase_ExactAdvertisedTerms_Succeeds() public {
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE * 2);
        vm.startPrank(buyer);
        erc20.approve(address(fpm), PRICE * 2);
        fpm.purchase(address(nft), ID, 2, address(erc20), PRICE * 2); // exactly the terms on offer
        vm.stopPrank();

        assertEq(nft.balanceOf(buyer, ID), 2);
        assertEq(erc20.balanceOf(payee), PRICE * 2);
    }

    function test_Purchase_OwnerFrontRunsPrice_RevertsAndAllowanceUntouched() public {
        // The theft path the guard closes, edition-shaped: the total is pulled from a STANDING
        // allowance, so an unbounded price spends whatever the buyer approved.
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(erc20), PRICE, N);
        erc20.mint(buyer, 100 * PRICE);
        vm.prank(buyer);
        erc20.approve(address(fpm), 100 * PRICE); // approve-once, the common wallet pattern

        vm.prank(owner);
        fpm.configure(address(nft), ID, address(erc20), 50 * PRICE, N); // front-run

        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter1155.SaleTermsChanged.selector);
        fpm.purchase(address(nft), ID, 2, address(erc20), PRICE * 2); // bounded at the advertised total

        assertEq(erc20.balanceOf(buyer), 100 * PRICE); // not one unit moved
        assertEq(erc20.balanceOf(payee), 0);
        assertEq(nft.balanceOf(buyer, ID), 0);
    }

    function test_Purchase_OwnerSwitchesPaymentToken_Reverts() public {
        MockERC20_1155 other = new MockERC20_1155();
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE);
        other.mint(buyer, PRICE);
        vm.startPrank(buyer);
        erc20.approve(address(fpm), PRICE);
        other.approve(address(fpm), PRICE); // a standing approval left over from some other sale
        vm.stopPrank();

        vm.prank(owner);
        fpm.configure(address(nft), ID, address(other), PRICE, N);

        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter1155.SaleTermsChanged.selector);
        fpm.purchase(address(nft), ID, 1, address(erc20), PRICE);

        assertEq(other.balanceOf(buyer), PRICE); // the other allowance is untouched
        assertEq(nft.balanceOf(buyer, ID), 0);
    }

    function test_Purchase_MaxTotalPriceScalesWithQuantity() public {
        // `maxTotalPrice` bounds the TOTAL, so `qty` is inside the bound: a buyer who authorized two
        // copies' worth cannot be sold three, even though the unit price never moved.
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(0), PRICE, N);
        vm.deal(buyer, PRICE * 5);

        vm.prank(buyer);
        vm.expectRevert(AbxFixedPriceMinter1155.SaleTermsChanged.selector);
        fpm.purchase{value: PRICE * 3}(address(nft), ID, 3, address(0), PRICE * 2);

        // the same unit price, bounded for what they actually asked for, settles
        vm.prank(buyer);
        fpm.purchase{value: PRICE * 3}(address(nft), ID, 3, address(0), PRICE * 3);
        assertEq(nft.balanceOf(buyer, ID), 3);
    }

    function test_Purchase_PriceDecrease_UnderMaxTotal_Succeeds() public {
        // The guard is a ceiling, not an equality — a price CUT still settles, at the new total.
        vm.prank(owner);
        fpm.configure(address(nft), ID, address(erc20), PRICE, N);
        erc20.mint(buyer, PRICE * 2);
        vm.prank(buyer);
        erc20.approve(address(fpm), PRICE * 2);

        vm.prank(owner);
        fpm.configure(address(nft), ID, address(erc20), PRICE / 2, N); // owner cuts the price

        vm.prank(buyer);
        fpm.purchase(address(nft), ID, 2, address(erc20), PRICE * 2); // bounded by the old total

        assertEq(erc20.balanceOf(payee), PRICE); // 2 × the cut price
        assertEq(nft.balanceOf(buyer, ID), 2);
    }

    // ---- multi-tenant + per-id isolation ----

    function test_MultiId_IsolatedSalesOnTheSameToken() public {
        vm.prank(owner);
        fpm.configure(address(nft), 0, address(0), PRICE, N);
        vm.prank(owner);
        fpm.configure(address(nft), 1, address(0), PRICE * 2, N);

        vm.deal(buyer, PRICE * 3);
        vm.startPrank(buyer);
        fpm.purchase{value: PRICE}(address(nft), 0, 1, address(0), PRICE);
        fpm.purchase{value: PRICE * 2}(address(nft), 1, 1, address(0), PRICE * 2);
        vm.stopPrank();

        assertEq(nft.balanceOf(buyer, 0), 1);
        assertEq(nft.balanceOf(buyer, 1), 1);
        assertEq(_sold(address(nft), 0), 1);
        assertEq(_sold(address(nft), 1), 1);
    }

    // ---- reentrancy ----

    function test_Purchase_ReentrancyGuardBlocksReentry() public {
        ReentrantPayee1155 reentrantPayee = new ReentrantPayee1155(fpm, address(nft), ID);
        EditionImage n = _deploy(address(reentrantPayee), address(fpm), false);
        vm.prank(owner);
        fpm.configure(address(n), ID, address(0), PRICE, N);
        vm.deal(buyer, PRICE * 2);
        vm.prank(buyer);
        vm.expectRevert(); // ReentrancyGuard's Reentrancy() bubbles from the nested call
        fpm.purchase{value: PRICE}(address(n), ID, 1, address(0), PRICE);
    }

    /// @dev The receiver-callback reentry vector: the mint recipient re-enters `purchase` from
    ///      `onERC1155Received`, which Solady's `_mint` fires mid-mint.
    ///      The guard must block it there just as it does the payee `receive()` vector above. A free
    ///      mint (price 0) so the nested call needs no value — the guard, not a payment check, is
    ///      what must stop it.
    function test_Purchase_ReentrancyGuardBlocksReceiverCallback() public {
        ReentrantReceiver1155 attacker = new ReentrantReceiver1155(fpm);
        EditionImage n = _deploy(payee, address(fpm), false);
        attacker.arm(address(n), ID);
        vm.prank(owner);
        fpm.configure(address(n), ID, address(0), 0, N); // free mint
        vm.prank(buyer);
        vm.expectRevert(); // ReentrancyGuard's Reentrancy() bubbles from the receiver callback
        fpm.purchaseTo(address(n), ID, 1, address(attacker), address(0), 0);
    }
}
