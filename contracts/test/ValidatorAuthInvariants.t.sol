// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {SeriesImage} from "../src/tokens/SeriesImage.sol";
import {SeriesImageFactory} from "../src/factories/SeriesImageFactory.sol";
import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {OneOfOneEdition} from "../src/tokens/OneOfOneEdition.sol";
import {OneOfOneEditionFactory} from "../src/factories/OneOfOneEditionFactory.sol";
import {EditionImage} from "../src/tokens/EditionImage.sol";
import {EditionImageFactory} from "../src/factories/EditionImageFactory.sol";
import {EditionCode} from "../src/tokens/EditionCode.sol";
import {EditionCodeFactory} from "../src/factories/EditionCodeFactory.sol";
import {ICreatorToken} from "../src/interfaces/ICreatorToken.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Any address with code that refuses an unknown selector — all `_requireHasCode` asks for.
contract StubValidator {
    function validateTransfer(address, address, address, uint256) external {}
    function validateTransfer(address, address, address, uint256, uint256) external {}
}

/// @title ValidatorAuthInvariants — "a stranger may never re-point the transfer validator", asserted
///        on EVERY token type rather than on one of them
///
/// @dev This file exists because the guard is not in one place. `CreatorToken` (the 721 lane) holds
///      its own `_requireValidatorAuth` inside the setter, but `CreatorToken1155`'s setter carries
///      NO authorization at all — it delegates straight to {AbxEditionLib-setTransferValidator},
///      which does not authorize either. What actually protects the three edition types is that
///      each one *overrides* the setter and calls `_requireValidatorCaller` before delegating.
///      Three copies of a guard, and the mixin they override is unguarded.
///
///      That is the exact shape this repo has been bitten by three times (a body in two places,
///      with the fix landing in the copy that does not run), and the previous coverage asserted the
///      rule on `EditionImage` alone — so a new edition type, or a dropped override, would ship an
///      unauthenticated `setTransferValidator` with nothing failing. Enforcing the invariant across
///      all six types is the cheap half of the fix; the mixin's own shape is a finding in the
///      2026-08-14 review record.
contract ValidatorAuthInvariantsTest is Test {
    address internal constant OWNER = address(0xA11CE);
    address internal constant STRANGER = address(0xBEEF);

    StubValidator internal v1;
    StubValidator internal v2;

    function setUp() public {
        v1 = new StubValidator();
        v2 = new StubValidator();
    }

    // ── the shared assertions, run against each deployed token ─────────────────

    /// A stranger may not re-point, and may not suspend, while an owner exists. The owner may.
    function _assertOwnerOnlyWhileOwned(address token) internal {
        vm.prank(STRANGER);
        vm.expectRevert(Ownable.Unauthorized.selector);
        ICreatorToken(token).setTransferValidator(address(v2));

        vm.prank(STRANGER);
        vm.expectRevert(Ownable.Unauthorized.selector);
        ICreatorToken(token).setTransferValidator(address(0));

        vm.prank(OWNER);
        ICreatorToken(token).setTransferValidator(address(v2));
        assertEq(ICreatorToken(token).getTransferValidator(), address(v2), "owner may re-point");
    }

    /// Once ownerless the release valve opens — but only ever toward transferability.
    function _assertDeadManReleaseIsSuspendOnly(address token) internal {
        vm.prank(OWNER);
        Ownable(token).renounceOwnership();

        vm.prank(STRANGER);
        vm.expectRevert(Ownable.Unauthorized.selector);
        ICreatorToken(token).setTransferValidator(address(v2)); // never re-arm

        vm.prank(STRANGER);
        ICreatorToken(token).setTransferValidator(address(0)); // suspend only
        assertEq(ICreatorToken(token).getTransferValidator(), address(0), "stranger may suspend");
    }

    function _assertBoth(address token) internal {
        _assertOwnerOnlyWhileOwned(token);
        _assertDeadManReleaseIsSuspendOnly(token);
    }

    // ── ERC-721 lane ───────────────────────────────────────────────────────────

    function test_OneOfOneImage_ValidatorIsOwnerGated() public {
        _assertBoth(_deployOneOfOneImage());
    }

    function test_SeriesImage_ValidatorIsOwnerGated() public {
        _assertBoth(_deploySeriesImage());
    }

    function test_SeriesCode_ValidatorIsOwnerGated() public {
        _assertBoth(_deploySeriesCode());
    }

    // ── ERC-1155 lane (the three whose guard lives in an override) ──────────────

    function test_OneOfOneEdition_ValidatorIsOwnerGated() public {
        _assertBoth(_deployOneOfOneEdition());
    }

    function test_EditionImage_ValidatorIsOwnerGated() public {
        _assertBoth(_deployEditionImage());
    }

    function test_EditionCode_ValidatorIsOwnerGated() public {
        _assertBoth(_deployEditionCode());
    }

    // ── deploys ────────────────────────────────────────────────────────────────

    function _deployOneOfOneImage() internal returns (address) {
        OneOfOneImageFactory f = new OneOfOneImageFactory();
        return f.deploy(
            OneOfOneImage.InitParams({
                owner: OWNER,
                mintTo: address(0),
                name: "One",
                symbol: "ONE",
                tokenURIBase: "https://abx.test/t",
                tokenURIRenderer: address(0),
                contractURIBase: "https://abx.test/c",
                contractURIRenderer: address(0),
                royaltyReceiver: OWNER,
                royaltyBps: 500,
                maxRoyaltyBps: 1000,
                burnable: false,
                transferValidator: address(v1),
                tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
                contractFields: new IAbxOnChainMetadata.FieldInput[](0)
            })
        );
    }

    function _deploySeriesImage() internal returns (address) {
        SeriesImageFactory f = new SeriesImageFactory();
        return f.deploy(
            SeriesImage.InitParams({
                owner: OWNER,
                name: "Series",
                symbol: "SER",
                tokenURIBase: "https://abx.test/t",
                tokenURIRenderer: address(0),
                contractURIBase: "https://abx.test/c",
                contractURIRenderer: address(0),
                royaltyReceiver: OWNER,
                royaltyBps: 500,
                maxRoyaltyBps: 1000,
                burnable: false,
                transferValidator: address(v1),
                maxInvocations: 10,
                primaryPayee: address(0),
                minter: address(0),
                paused: false,
                mintTo: address(0),
                mintCount: 0,
                tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
                contractFields: new IAbxOnChainMetadata.FieldInput[](0)
            })
        );
    }

    function _deploySeriesCode() internal returns (address) {
        SeriesCodeFactory f = new SeriesCodeFactory();
        return f.deploy(
            SeriesCode.InitParams({
                owner: OWNER,
                name: "Code",
                symbol: "COD",
                tokenURIBase: "https://abx.test/t",
                tokenURIRenderer: address(0),
                contractURIBase: "https://abx.test/c",
                contractURIRenderer: address(0),
                royaltyReceiver: OWNER,
                royaltyBps: 500,
                maxRoyaltyBps: 1000,
                burnable: false,
                transferValidator: address(v1),
                maxInvocations: 10,
                primaryPayee: address(0),
                minter: address(0),
                paused: false,
                seedSource: address(0),
                disableTokenOwnerDelegation: false,
                mintTo: address(0),
                mintCount: 0,
                tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
                contractFields: new IAbxOnChainMetadata.FieldInput[](0)
            })
        );
    }

    function _deployOneOfOneEdition() internal returns (address) {
        OneOfOneEditionFactory f = new OneOfOneEditionFactory();
        return f.deploy(
            OneOfOneEdition.InitParams({
                owner: OWNER,
                mintTo: address(0),
                mintAmount: 0,
                name: "Ed",
                symbol: "ED",
                tokenURIBase: "https://abx.test/t",
                tokenURIRenderer: address(0),
                contractURIBase: "https://abx.test/c",
                contractURIRenderer: address(0),
                royaltyReceiver: OWNER,
                royaltyBps: 500,
                maxRoyaltyBps: 1000,
                burnable: false,
                transferValidator: address(v1),
                editionSize: 0,
                primaryPayee: address(0),
                minter: address(0),
                paused: false,
                tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
                contractFields: new IAbxOnChainMetadata.FieldInput[](0)
            })
        );
    }

    function _deployEditionImage() internal returns (address) {
        EditionImageFactory f = new EditionImageFactory();
        return f.deploy(
            EditionImage.InitParams({
                owner: OWNER,
                name: "EdImg",
                symbol: "EIM",
                tokenURIBase: "https://abx.test/t",
                tokenURIRenderer: address(0),
                contractURIBase: "https://abx.test/c",
                contractURIRenderer: address(0),
                royaltyReceiver: OWNER,
                royaltyBps: 500,
                maxRoyaltyBps: 1000,
                burnable: false,
                transferValidator: address(v1),
                maxInvocations: 10,
                editionSize: 0,
                primaryPayee: address(0),
                minter: address(0),
                paused: false,
                mintTo: address(0),
                mintCount: 0,
                mintAmount: 0,
                tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
                contractFields: new IAbxOnChainMetadata.FieldInput[](0)
            })
        );
    }

    function _deployEditionCode() internal returns (address) {
        EditionCodeFactory f = new EditionCodeFactory();
        return f.deploy(
            EditionCode.InitParams({
                owner: OWNER,
                name: "EdCode",
                symbol: "ECO",
                tokenURIBase: "https://abx.test/t",
                tokenURIRenderer: address(0),
                contractURIBase: "https://abx.test/c",
                contractURIRenderer: address(0),
                royaltyReceiver: OWNER,
                royaltyBps: 500,
                maxRoyaltyBps: 1000,
                burnable: false,
                transferValidator: address(v1),
                maxInvocations: 10,
                editionSize: 0,
                primaryPayee: address(0),
                minter: address(0),
                paused: false,
                seedSource: address(0),
                mintTo: address(0),
                mintCount: 0,
                mintAmount: 0,
                tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
                contractFields: new IAbxOnChainMetadata.FieldInput[](0)
            })
        );
    }
}
