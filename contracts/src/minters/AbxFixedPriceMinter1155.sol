// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {IAbxEditionMint} from "../interfaces/IAbxEditionMint.sol";
import {IAbxPrimaryPayee} from "../extensions/primary-payee/IAbxPrimaryPayee.sol";

/// @title AbxFixedPriceMinter1155 — the reference fixed-price sale contract for ABX editions
///
/// @dev **These events are not an authenticity registry, and consumers must not read them as one.**
///      This minter is shared, ownerless, and deliberately neutral: it will configure a sale for any
///      contract exposing the expected `owner`, payee, and mint-shaped calls, because refusing
///      unknown ERC-1155 contracts would make it a gatekeeper rather than a public utility. A hostile
///      contract can therefore configure itself here, accept payment, make `mint` a no-op, and cause
///      the canonical minter to emit `SaleConfigured` and `Purchase` with no token issued.
///
///      That does not reach a buyer who is anchored to a trust anchor — they named the target — but
///      an indexer that treats a `Purchase` from this address as proof a canonical NFT was sold will
///      be wrong. Verify the token with its factory's `isAbxClone`, verify the token actually
///      selected this minter, and reconcile the purchase against the token's own `Transfer` /
///      `TransferSingle`. ERC-165 does not authenticate a contract that wants to lie.
/// @notice The structural sibling of {AbxFixedPriceMinter}, keyed one step finer: sales are
///         `(token, id)`, since an edition project prices each id — each distinct work — on
///         its own terms. One **ownerless, multi-tenant singleton** (deployed once per chain);
///         per-`(token, id)` sale terms, and **all authority defers to that token's owner** — the
///         minter has no admin of its own. It sells any token exposing {IAbxEditionMint}, mints
///         **exactly `qty` copies of `id`** per call, and routes proceeds to the token's declared
///         `primaryPayee()`. It implements the Minter spine's edition lane
///         (`specs/protocol/minter-spine.md`): `SaleConfigured` / `Purchase`.
///
/// @dev Two independent grants, both the project owner's — and diagnosable in isolation:
///      1. **Mint rights** — the owner assigns this minter on the token
///         (`token.setMinter(address(this))`, the External Minter extension). Without it, `mint`
///         reverts inside the token; the buyer sees that revert.
///      2. **Sale terms** — the owner calls {configure} here, gated by `token.owner()`. Without
///         it, {purchase}/{purchaseTo} revert {NotConfigured}.
///
///      Non-custodial: ERC-20 proceeds move buyer → payee directly (never held here); ETH transits
///      only within a single `nonReentrant` call (collect → mint → forward), effects before
///      interactions (`sold` is credited before any external call, exactly like the 721 twin). The
///      token's Paused extension is the sale's on/off switch — while paused the token rejects a
///      minter's mint, so {purchase}/{purchaseTo} revert until the owner unpauses. Exact payment
///      only (no refunds in V1) — `price * qty`.
///
///      **The buyer states the terms they accept**, exactly as in the 721 twin:
///      `purchase`/`purchaseTo` take `expectedPaymentToken` and `maxTotalPrice` and revert
///      {SaleTermsChanged} on a mismatch. Bounding the *total* rather than the unit price is
///      deliberate here — the total is what leaves the buyer's balance, and `qty` multiplies it.
///
///      **1/1 editions are in scope here** — unlike {AbxFixedPriceMinter}, which the 721 1/1
///      ({OneOfOneImage}) sits out by design (no sequential primitive). {OneOfOneEdition} exposes
///      {IAbxEditionMint} (id space fixed to `0`) and is a first-class target of this minter.
contract AbxFixedPriceMinter1155 is ReentrancyGuard {
    using SafeTransferLib for address;

    /// @notice Per-`(token, id)` sale terms.
    /// @param configured A sale must be configured before any purchase (distinguishes "unset"
    ///        from a genuine zero-price free mint).
    /// @param paymentToken `address(0)` = ETH; otherwise the ERC-20 priced in.
    /// @param price Raw units per COPY (wei, or the ERC-20's base units).
    /// @param allocation Max copies THIS minter may sell for this `(token, id)` (its budget —
    ///        orthogonal to the token's own per-id `maxSupply`; the tighter binds).
    /// @param sold Running count sold by this minter, always `<= allocation`.
    struct Sale {
        bool configured;
        address paymentToken;
        uint256 price;
        uint256 allocation;
        uint256 sold;
    }

    /// @notice Sale terms by `(token, id)` (public getter returns the full struct).
    mapping(address token => mapping(uint256 id => Sale)) public sales;

    // ── Minter spine events (id-keyed twins of {AbxFixedPriceMinter}'s) ─────────

    /// @notice The project owner set/updated the sale terms for `(token, id)`.
    ///         `paymentToken == address(0)` ⇒ ETH.
    event SaleConfigured(
        address indexed token,
        uint256 indexed id,
        address paymentToken,
        uint256 price,
        uint256 allocation
    );

    /// @notice A purchase settled: `amount` copies of `id` minted to `to`; `buyer` paid
    ///         `amount * price` in `paymentToken` (`address(0)` = ETH).
    event Purchase(
        address indexed token,
        address indexed buyer,
        address indexed to,
        uint256 id,
        uint256 amount,
        address paymentToken,
        uint256 price
    );

    // ── errors ──────────────────────────────────────────────────────────────────

    /// @notice Caller is not the ABX token's owner.
    error NotProjectOwner();
    /// @notice New allocation is below the amount already sold (would strand accounting).
    error AllocationBelowSold();
    /// @notice No sale is configured for this `(token, id)`.
    error NotConfigured();
    /// @notice This minter's allocation for the `(token, id)` is exhausted.
    error AllocationExhausted();
    /// @notice The token has no primary payee set — proceeds would have nowhere to go.
    error NoPrimaryPayee();
    /// @notice Wrong payment: ETH value ≠ `price * qty`, or ETH sent for an ERC-20 sale.
    error WrongPayment();
    /// @notice A purchase of 0 copies was requested.
    error ZeroQuantity();
    /// @notice The live sale terms don't match what the buyer signed for — the total is above
    ///         `maxTotalPrice`, or the sale is priced in a different token than
    ///         `expectedPaymentToken`.
    error SaleTermsChanged();

    // ── configuration (defers to the token owner) ────────────────────────────────

    /// @notice Owner-of-`token` sets or updates the sale terms for `id`. Idempotent; a later call
    ///         replaces the terms (allocation must stay `>=` what's already sold). Enabling the
    ///         sale is separate from granting mint rights — the owner must also
    ///         `token.setMinter(this)`.
    function configure(
        address token,
        uint256 id,
        address paymentToken,
        uint256 price,
        uint256 allocation
    ) external {
        if (msg.sender != _projectOwner(token)) revert NotProjectOwner();
        Sale storage s = sales[token][id];
        if (allocation < s.sold) revert AllocationBelowSold();
        s.configured = true;
        s.paymentToken = paymentToken;
        s.price = price;
        s.allocation = allocation;
        emit SaleConfigured(token, id, paymentToken, price, allocation);
    }

    // ── purchase (public) ─────────────────────────────────────────────────────────

    /// @notice Buy `qty` copies of `id`, minted to the caller.
    /// @param expectedPaymentToken The token the buyer expects to pay in (`address(0)` = ETH).
    /// @param maxTotalPrice The most the buyer authorizes in total for all `qty` copies.
    function purchase(
        address token,
        uint256 id,
        uint256 qty,
        address expectedPaymentToken,
        uint256 maxTotalPrice
    ) external payable nonReentrant {
        _purchase(token, id, qty, msg.sender, expectedPaymentToken, maxTotalPrice);
    }

    /// @notice Buy `qty` copies of `id`, minted to `to`.
    /// @param expectedPaymentToken The token the buyer expects to pay in (`address(0)` = ETH).
    /// @param maxTotalPrice The most the buyer authorizes in total for all `qty` copies.
    function purchaseTo(
        address token,
        uint256 id,
        uint256 qty,
        address to,
        address expectedPaymentToken,
        uint256 maxTotalPrice
    ) external payable nonReentrant {
        _purchase(token, id, qty, to, expectedPaymentToken, maxTotalPrice);
    }

    /// @dev Collect exactly `price * qty` → mint `qty` copies of `id` → forward proceeds to the
    ///      token's `primaryPayee()`. Effects (`sold`) before interactions; the whole call is
    ///      `nonReentrant`.
    function _purchase(
        address token,
        uint256 id,
        uint256 qty,
        address to,
        address expectedPaymentToken,
        uint256 maxTotalPrice
    ) internal {
        if (qty == 0) revert ZeroQuantity();
        Sale storage s = sales[token][id];
        if (!s.configured) revert NotConfigured();
        if (s.sold + qty > s.allocation) revert AllocationExhausted();

        // proceeds destination is the token's single source of truth, read fresh each purchase
        address payee = IAbxPrimaryPayee(token).primaryPayee();
        if (payee == address(0)) revert NoPrimaryPayee();

        uint256 price = s.price;
        address paymentToken = s.paymentToken;
        uint256 totalPrice = price * qty;
        // the buyer's slippage guard — see {AbxFixedPriceMinter-_requireTermsUnchanged} for why
        // both parameters are mandatory. Bounds the TOTAL, which is what leaves their balance.
        if (paymentToken != expectedPaymentToken) revert SaleTermsChanged();
        if (totalPrice > maxTotalPrice) revert SaleTermsChanged();

        // effects first
        s.sold += qty;

        // collect payment
        if (paymentToken == address(0)) {
            if (msg.value != totalPrice) revert WrongPayment();
            // ETH forwarded after the mint, still inside nonReentrant (see below)
        } else {
            if (msg.value != 0) revert WrongPayment();
            paymentToken.safeTransferFrom(msg.sender, payee, totalPrice); // buyer → payee, non-custodial
        }

        // mint (reverts here if this minter isn't the token's assigned minter, or it's paused,
        // or the token's own id-space/per-id caps are reached — all bubble up and revert the
        // whole purchase)
        IAbxEditionMint(token).mint(to, id, qty);

        // forward ETH proceeds
        if (paymentToken == address(0) && totalPrice != 0) {
            payee.safeTransferETH(totalPrice);
        }

        emit Purchase(token, msg.sender, to, id, qty, paymentToken, price);
    }

    /// @dev The sale authority for a project is its ABX token's owner (EIP-173 / Solady Ownable).
    function _projectOwner(address token) internal view returns (address) {
        return Ownable(token).owner();
    }
}
