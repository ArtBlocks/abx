// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {IAbxSequentialMint} from "../interfaces/IAbxSequentialMint.sol";
import {IAbxPrimaryPayee} from "../extensions/primary-payee/IAbxPrimaryPayee.sol";

/// @title AbxFixedPriceMinter — the reference fixed-price sale contract for ABX drops
///
/// @dev **These events are not an authenticity registry, and consumers must not read them as one.**
///      This minter is shared, ownerless, and deliberately neutral: it will configure a sale for any
///      contract exposing the expected `owner`, payee, and mint-shaped calls, because refusing
///      unknown ERC-721 contracts would make it a gatekeeper rather than a public utility. A hostile
///      contract can therefore configure itself here, accept payment, make `mint` a no-op, and cause
///      the canonical minter to emit `SaleConfigured` and `Purchase` with no token issued.
///
///      That does not reach a buyer who is anchored to a trust anchor — they named the target — but
///      an indexer that treats a `Purchase` from this address as proof a canonical NFT was sold will
///      be wrong. Verify the token with its factory's `isAbxClone`, verify the token actually
///      selected this minter, and reconcile the purchase against the token's own `Transfer` /
///      `TransferSingle`. ERC-165 does not authenticate a contract that wants to lie.
/// @notice One **ownerless, multi-tenant singleton** (deployed once per chain, like the
///         factories/renderer): per-project sale terms are keyed by the ABX token address, and
///         **all authority defers to that token's owner** — the minter has no admin of its own.
///         It sells any token exposing {IAbxSequentialMint}, mints **one token per call**, and
///         routes proceeds to the token's declared `primaryPayee()`. Its shared event vocabulary is
///         `SaleConfigured` / `Purchase`.
///
/// @dev Two independent grants, both the project owner's — and diagnosable in isolation:
///      1. **Mint rights** — the owner assigns this minter on the token
///         (`token.setMinter(address(this))`, the External Minter extension). Without it, `mint`
///         reverts inside the token; the buyer sees that revert.
///      2. **Sale terms** — the owner calls {configure} here, gated by `token.owner()`. Without
///         it, {purchase} reverts {NotConfigured}.
///
///      Non-custodial: ERC-20 proceeds move buyer → payee directly (never held here); ETH transits
///      only within a single `nonReentrant` call (collect → mint → forward), effects before
///      interactions. The token's Paused extension is the sale's on/off switch — while paused the
///      token rejects a minter's mint, so {purchase} reverts until the owner unpauses. Exact
///      payment only (no refunds in V1).
///
///      **The buyer states the terms they accept.** `purchase`/`purchaseTo` take
///      `expectedPaymentToken` and `maxPrice`, and revert {SaleTermsChanged} if the live sale
///      doesn't match. {configure} has no timelock, so this is what stops a project owner from
///      front-running a pending purchase and spending the buyer's whole ERC-20 allowance. Both
///      parameters are required, not optional — see {_requireTermsUnchanged}.
contract AbxFixedPriceMinter is ReentrancyGuard {
    using SafeTransferLib for address;

    /// @notice Per-project sale terms, keyed by ABX token address.
    /// @param configured A sale must be configured before any purchase (distinguishes "unset"
    ///        from a genuine zero-price free mint).
    /// @param paymentToken `address(0)` = ETH; otherwise the ERC-20 priced in.
    /// @param price Raw units per token (wei, or the ERC-20's base units).
    /// @param allocation Max tokens THIS minter may sell for this project (its budget — orthogonal
    ///        to the token's own `maxInvocations` cap; the tighter binds).
    /// @param sold Running count sold by this minter, always `<= allocation`.
    struct Sale {
        bool configured;
        address paymentToken;
        uint256 price;
        uint256 allocation;
        uint256 sold;
    }

    /// @notice Sale terms by ABX token address (public getter returns the full struct).
    mapping(address token => Sale) public sales;

    // ── Minter spine events ─────────────────────────────────────────────────────

    /// @notice The project owner set/updated the sale terms for `token`.
    ///         `paymentToken == address(0)` ⇒ ETH.
    event SaleConfigured(
        address indexed token, address paymentToken, uint256 price, uint256 allocation
    );

    /// @notice A purchase settled: one token (`tokenId`) minted to `to`; `buyer` paid `price` in
    ///         `paymentToken` (`address(0)` = ETH).
    event Purchase(
        address indexed token,
        address indexed buyer,
        address indexed to,
        uint256 tokenId,
        address paymentToken,
        uint256 price
    );

    // ── errors ──────────────────────────────────────────────────────────────────

    /// @notice Caller is not the ABX token's owner.
    error NotProjectOwner();
    /// @notice New allocation is below the amount already sold (would strand accounting).
    error AllocationBelowSold();
    /// @notice No sale is configured for this token.
    error NotConfigured();
    /// @notice This minter's allocation for the project is exhausted.
    error AllocationExhausted();
    /// @notice The token has no primary payee set — proceeds would have nowhere to go.
    error NoPrimaryPayee();
    /// @notice Wrong payment: ETH value ≠ price, or ETH sent for an ERC-20 sale.
    error WrongPayment();
    /// @notice The live sale terms don't match what the buyer signed for — the price is above
    ///         `maxPrice`, or the sale is priced in a different token than `expectedPaymentToken`.
    error SaleTermsChanged();

    // ── configuration (defers to the token owner) ────────────────────────────────

    /// @notice Owner-of-`token` sets or updates the sale terms. Idempotent; a later call replaces
    ///         the terms (allocation must stay `>=` what's already sold). Enabling the sale is
    ///         separate from granting mint rights — the owner must also `token.setMinter(this)`.
    function configure(address token, address paymentToken, uint256 price, uint256 allocation)
        external
    {
        if (msg.sender != _projectOwner(token)) revert NotProjectOwner();
        Sale storage s = sales[token];
        if (allocation < s.sold) revert AllocationBelowSold();
        s.configured = true;
        s.paymentToken = paymentToken;
        s.price = price;
        s.allocation = allocation;
        emit SaleConfigured(token, paymentToken, price, allocation);
    }

    // ── purchase (public) ─────────────────────────────────────────────────────────

    /// @notice Buy one token, minted to the caller.
    /// @param expectedPaymentToken The token the buyer expects to pay in (`address(0)` = ETH).
    /// @param maxPrice The most the buyer authorizes for this token, in `expectedPaymentToken`'s
    ///        base units. See {_requireTermsUnchanged} for why both are mandatory.
    function purchase(address token, address expectedPaymentToken, uint256 maxPrice)
        external
        payable
        nonReentrant
        returns (uint256 tokenId)
    {
        return _purchase(token, msg.sender, expectedPaymentToken, maxPrice);
    }

    /// @notice Buy one token, minted to `to`.
    /// @param expectedPaymentToken The token the buyer expects to pay in (`address(0)` = ETH).
    /// @param maxPrice The most the buyer authorizes for this token.
    function purchaseTo(
        address token,
        address to,
        address expectedPaymentToken,
        uint256 maxPrice
    ) external payable nonReentrant returns (uint256 tokenId) {
        return _purchase(token, to, expectedPaymentToken, maxPrice);
    }

    /// @dev Collect exactly `price` → mint one → forward proceeds to the token's `primaryPayee()`.
    ///      Effects (`sold`) before interactions; the whole call is `nonReentrant`.
    function _purchase(
        address token,
        address to,
        address expectedPaymentToken,
        uint256 maxPrice
    ) internal returns (uint256 tokenId) {
        Sale storage s = sales[token];
        if (!s.configured) revert NotConfigured();
        if (s.sold >= s.allocation) revert AllocationExhausted();

        // proceeds destination is the token's single source of truth, read fresh each purchase
        address payee = IAbxPrimaryPayee(token).primaryPayee();
        if (payee == address(0)) revert NoPrimaryPayee();

        uint256 price = s.price;
        address paymentToken = s.paymentToken;
        _requireTermsUnchanged(paymentToken, price, expectedPaymentToken, maxPrice);

        // effects first
        unchecked {
            s.sold += 1;
        }

        // collect payment
        if (paymentToken == address(0)) {
            if (msg.value != price) revert WrongPayment();
            // ETH forwarded after the mint, still inside nonReentrant (see below)
        } else {
            if (msg.value != 0) revert WrongPayment();
            paymentToken.safeTransferFrom(msg.sender, payee, price); // buyer → payee, non-custodial
        }

        // mint (reverts here if this minter isn't the token's assigned minter, or it's paused,
        // or the token's own cap is reached — all bubble up and revert the whole purchase)
        tokenId = IAbxSequentialMint(token).mint(to);

        // forward ETH proceeds
        if (paymentToken == address(0) && price != 0) {
            payee.safeTransferETH(price);
        }

        emit Purchase(token, msg.sender, to, tokenId, paymentToken, price);
    }

    /// @dev The buyer's slippage guard, and the reason both parameters are mandatory rather than
    ///      optional: {configure} takes effect immediately, so without a bound the project owner
    ///      can front-run a pending purchase and move the terms under it. For ETH that is already
    ///      contained — `msg.value == price` means the buyer's own transaction caps the spend — but
    ///      an ERC-20 sale settles with `safeTransferFrom(buyer, payee, price)` against a standing
    ///      allowance, so an unbounded price spends whatever the buyer has approved. Asserting the
    ///      payment token too closes the sibling case: switching the sale to a *different* ERC-20
    ///      the buyer happens to have approved elsewhere.
    ///
    ///      Callers who genuinely want to accept any terms pass the terms they just read; there is
    ///      deliberately no "no maximum" sentinel, because a defaulted-away guard is the bug.
    function _requireTermsUnchanged(
        address paymentToken,
        uint256 price,
        address expectedPaymentToken,
        uint256 maxPrice
    ) internal pure {
        if (paymentToken != expectedPaymentToken) revert SaleTermsChanged();
        if (price > maxPrice) revert SaleTermsChanged();
    }

    /// @dev The sale authority for a project is its ABX token's owner (EIP-173 / Solady Ownable).
    function _projectOwner(address token) internal view returns (address) {
        return Ownable(token).owner();
    }
}
