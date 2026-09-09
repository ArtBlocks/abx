// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {EditionImage} from "../src/tokens/EditionImage.sol";
import {EditionImageFactory} from "../src/factories/EditionImageFactory.sol";
import {OneOfOneEdition} from "../src/tokens/OneOfOneEdition.sol";
import {OneOfOneEditionFactory} from "../src/factories/OneOfOneEditionFactory.sol";
import {CreatorToken1155} from "../src/extensions/creator-token/CreatorToken1155.sol";
import {ICreatorToken, ICreatorTokenLegacy} from "../src/interfaces/ICreatorToken.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev A validator that accepts by default and rejects everything when toggled — the toggle's
///      distinctive error proves the validator was (or wasn't) consulted. Records every call's
///      exact args (unlike the 721C validator, this one is NOT a view, so it can record state).
///      Also implements the best-effort `ITransferValidatorSetTokenType` surface so tests can
///      assert the Permit-C token-type registration fires on enroll and re-point.
contract MockTransferValidator1155 {
    error TransferDenied();

    bool public rejectAll;
    uint256 public callCount;
    address public lastCaller;
    address public lastFrom;
    address public lastTo;
    uint256 public lastId;
    uint256 public lastAmount;

    uint256 public tokenTypeRegistrations;
    address public lastRegisteredCollection;
    uint16 public lastRegisteredTokenType;

    function setRejectAll(bool value) external {
        rejectAll = value;
    }

    function validateTransfer(address caller, address from, address to, uint256 id, uint256 amount)
        external
    {
        ++callCount;
        lastCaller = caller;
        lastFrom = from;
        lastTo = to;
        lastId = id;
        lastAmount = amount;
        if (rejectAll) revert TransferDenied();
    }

    function setTokenTypeOfCollection(address collection, uint16 tokenType) external {
        ++tokenTypeRegistrations;
        lastRegisteredCollection = collection;
        lastRegisteredTokenType = tokenType;
    }
}

/// @dev A validator with NO `setTokenTypeOfCollection` at all — proves the best-effort
///      `try/catch` never bricks enrollment/re-pointing against an ecosystem validator that
///      predates (or simply omits) the Permit-C registration surface.
contract MockTransferValidator1155WithoutTokenTypeSurface {
    function validateTransfer(address, address, address, uint256, uint256) external {}
}

/// @notice Behavior of the opt-in ERC-1155C creator-token extension: deploy-time permanent
///         enrollment, enrollment-gated ERC-165 (SAME ids as the 721 side), the 5-arg
///         `validateTransfer` (with `amount`, NOT a view), per-id looping on batch transfers,
///         and the owner-managed validator lifecycle. Mirrors {CreatorTokenTest}'s scope for the
///         1155 twin, using {EditionImage} as the primary fixture (its non-sequential,
///         multi-copy ids exercise the batch/loop path {SeriesImage} never needs) plus an
///         {OneOfOneEdition} enrollment smoke.
contract CreatorToken1155Test is Test {
    event TransferValidatorUpdated(address oldValidator, address newValidator);

    EditionImageFactory internal factory;
    EditionImage internal nft;
    MockTransferValidator1155 internal validator;
    MockTransferValidator1155 internal validator2;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");
    address internal buyer = makeAddr("buyer");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant N = 5;

    bytes32 internal constant CREATOR_TOKEN_ID = keccak256("abx.extension.creator-token");
    bytes4 internal constant CREATOR_TOKEN_INTERFACE_ID = 0xad0d7f6c;
    bytes4 internal constant CREATOR_TOKEN_LEGACY_INTERFACE_ID = 0xa07d229a;
    bytes4 internal constant VALIDATE_TRANSFER_1155_SELECTOR = 0x1854b241;

    function setUp() public {
        factory = new EditionImageFactory();
        validator = new MockTransferValidator1155();
        validator2 = new MockTransferValidator1155();
        nft = _deploy(address(validator));
    }

    function _params(address transferValidator)
        internal
        view
        returns (EditionImage.InitParams memory)
    {
        return EditionImage.InitParams({
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
            transferValidator: transferValidator,
            maxInvocations: N,
            editionSize: 0,
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            mintTo: address(0),
            mintCount: 0,
            mintAmount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    function _deploy(address transferValidator) internal returns (EditionImage) {
        return EditionImage(factory.deploy(_params(transferValidator)));
    }

    function _mintOne() internal {
        vm.prank(owner);
        nft.mint(collector, 0, 3);
    }

    // ---- the ecosystem-fixed literals ----

    function test_InterfaceIds_MatchEcosystemLiterals() public pure {
        assertEq(bytes32(type(ICreatorToken).interfaceId), bytes32(CREATOR_TOKEN_INTERFACE_ID));
        assertEq(
            bytes32(type(ICreatorTokenLegacy).interfaceId),
            bytes32(CREATOR_TOKEN_LEGACY_INTERFACE_ID)
        );
    }

    function test_ValidationFunctionSelector_MatchesSignature() public pure {
        assertEq(
            bytes32(bytes4(keccak256("validateTransfer(address,address,address,uint256,uint256)"))),
            bytes32(VALIDATE_TRANSFER_1155_SELECTOR)
        );
    }

    // ---- unenrolled: a plain ERC-1155, indistinguishable from a pre-1155C token ----

    function test_Unenrolled_NoTrace() public {
        EditionImage plain = _deploy(address(0));
        assertFalse(plain.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertFalse(plain.supportsInterface(CREATOR_TOKEN_LEGACY_INTERFACE_ID));
        assertEq(plain.extensionVersion(CREATOR_TOKEN_ID), 0);
        assertEq(plain.getTransferValidator(), address(0));
    }

    function test_Unenrolled_SetTransferValidatorRevertsEvenForOwner() public {
        EditionImage plain = _deploy(address(0));
        vm.prank(owner);
        vm.expectRevert(CreatorToken1155.NotCreatorToken.selector);
        plain.setTransferValidator(address(validator));
    }

    function test_Unenrolled_TransfersFreely() public {
        EditionImage plain = _deploy(address(0));
        vm.prank(owner);
        plain.mint(collector, 0, 1);
        vm.prank(collector);
        plain.safeTransferFrom(collector, buyer, 0, 1, "");
        assertEq(plain.balanceOf(buyer, 0), 1);
    }

    // ---- enrolled: discovery + deploy-time guarantees ----

    function test_Enrolled_Discovery() public view {
        assertTrue(nft.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertTrue(nft.supportsInterface(CREATOR_TOKEN_LEGACY_INTERFACE_ID));
        assertEq(nft.extensionVersion(CREATOR_TOKEN_ID), 1);
        assertEq(nft.getTransferValidator(), address(validator));
    }

    function test_Enrolled_ValidationFunctionIsTheNonViewValidateTransferWithAmount() public view {
        (bytes4 sig, bool isViewFunction) = nft.getTransferValidationFunction();
        assertEq(bytes32(sig), bytes32(VALIDATE_TRANSFER_1155_SELECTOR));
        assertFalse(isViewFunction); // unlike 721C, this one is NOT a view
    }

    function test_Enrolled_DeployEmitsTransferValidatorUpdated() public {
        vm.expectEmit(false, false, false, true);
        emit TransferValidatorUpdated(address(0), address(validator));
        _deploy(address(validator));
    }

    function test_Deploy_RevertsCodelessValidator() public {
        EditionImage.InitParams memory p = _params(makeAddr("codeless"));
        vm.expectRevert(CreatorToken1155.InvalidTransferValidator.selector);
        factory.deploy(p);
    }

    // ---- Permit-C best-effort token-type registration ----

    function test_Enroll_RegistersTokenTypeErc1155() public {
        // `nft` was already deployed enrolled with `validator` in setUp.
        assertEq(validator.tokenTypeRegistrations(), 1);
        assertEq(validator.lastRegisteredCollection(), address(nft));
        assertEq(validator.lastRegisteredTokenType(), 1155);
    }

    function test_SetTransferValidator_RegistersTokenTypeOnTheNewValidator() public {
        vm.prank(owner);
        nft.setTransferValidator(address(validator2));
        assertEq(validator2.tokenTypeRegistrations(), 1);
        assertEq(validator2.lastRegisteredCollection(), address(nft));
        assertEq(validator2.lastRegisteredTokenType(), 1155);
    }

    function test_SetTransferValidator_ToZero_SkipsRegistration() public {
        uint256 before = validator.tokenTypeRegistrations();
        vm.prank(owner);
        nft.setTransferValidator(address(0)); // suspend — no validator to register against
        assertEq(validator.tokenTypeRegistrations(), before);
    }

    function test_Enroll_ValidatorWithoutTokenTypeSurface_NeverBricksDeploy() public {
        MockTransferValidator1155WithoutTokenTypeSurface bare =
            new MockTransferValidator1155WithoutTokenTypeSurface();
        EditionImage n = _deploy(address(bare)); // must not revert — try/catch swallows it
        assertEq(n.getTransferValidator(), address(bare));
        assertTrue(n.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
    }

    // ---- transfer semantics ----

    function test_Mint_NeverValidated() public {
        validator.setRejectAll(true);
        vm.prank(owner);
        nft.mint(collector, 0, 5); // mint (from == 0x0) is never validated
        assertEq(nft.balanceOf(collector, 0), 5);
        assertEq(validator.callCount(), 0);
    }

    function test_SingleTransfer_CallsValidatorWithIdAndAmount() public {
        _mintOne();
        vm.prank(collector);
        nft.safeTransferFrom(collector, buyer, 0, 2, "");
        assertEq(validator.callCount(), 1);
        assertEq(validator.lastCaller(), collector);
        assertEq(validator.lastFrom(), collector);
        assertEq(validator.lastTo(), buyer);
        assertEq(validator.lastId(), 0);
        assertEq(validator.lastAmount(), 2);
        assertEq(nft.balanceOf(buyer, 0), 2);
    }

    function test_OperatorTransfer_CallsValidatorWithOperatorAsCaller() public {
        _mintOne();
        vm.prank(collector);
        nft.setApprovalForAll(operator, true);
        vm.prank(operator);
        nft.safeTransferFrom(collector, buyer, 0, 1, "");
        assertEq(validator.lastCaller(), operator);
        assertEq(nft.balanceOf(buyer, 0), 1);
    }

    function test_BatchTransfer_LoopsValidatorOncePerId() public {
        vm.prank(owner);
        nft.mint(collector, 0, 3);
        vm.prank(owner);
        nft.mint(collector, 1, 4);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 3;
        amounts[1] = 4;

        vm.prank(collector);
        nft.safeBatchTransferFrom(collector, buyer, ids, amounts, "");
        assertEq(validator.callCount(), 2); // one call per id — no batch validator entrypoint
        assertEq(validator.lastId(), 1);
        assertEq(validator.lastAmount(), 4);
    }

    function test_ValidatorRevert_BlocksTransferAndBubbles() public {
        _mintOne();
        validator.setRejectAll(true);
        vm.prank(collector);
        vm.expectRevert(MockTransferValidator1155.TransferDenied.selector);
        nft.safeTransferFrom(collector, buyer, 0, 1, "");
        assertEq(nft.balanceOf(collector, 0), 3); // unmoved
    }

    function test_BatchTransfer_OneBadIdRevertsTheWholeBatch() public {
        vm.prank(owner);
        nft.mint(collector, 0, 3);
        vm.prank(owner);
        nft.mint(collector, 1, 4);
        validator.setRejectAll(true);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 3;
        amounts[1] = 4;

        vm.prank(collector);
        vm.expectRevert(MockTransferValidator1155.TransferDenied.selector);
        nft.safeBatchTransferFrom(collector, buyer, ids, amounts, "");
        assertEq(nft.balanceOf(collector, 0), 3); // atomic — nothing moved
    }

    function test_SuspendedValidator_TransfersPassWithNoCall() public {
        _mintOne();
        validator.setRejectAll(true);
        vm.prank(owner);
        nft.setTransferValidator(address(0));
        vm.prank(collector);
        nft.safeTransferFrom(collector, buyer, 0, 1, "");
        assertEq(nft.balanceOf(buyer, 0), 1);
        assertTrue(nft.supportsInterface(CREATOR_TOKEN_INTERFACE_ID)); // still enrolled
    }

    function test_ValidatorInitiatedTransfer_SkipsValidation() public {
        _mintOne();
        validator.setRejectAll(true);
        vm.prank(collector);
        nft.setApprovalForAll(address(validator), true);
        vm.prank(address(validator));
        nft.safeTransferFrom(collector, buyer, 0, 1, "");
        assertEq(nft.balanceOf(buyer, 0), 1);
        assertEq(validator.callCount(), 0);
    }

    // ---- the dead-man release (the 1155 lane runs AbxEditionLib, not this mixin) ----
    //
    // All three edition tokens override `setTransferValidator` to delegate into `AbxEditionLib`, so
    // the body exercised here is a different implementation from `CreatorToken`'s. Cover it
    // directly so a fix cannot land only in a mixin while the library remains unchanged.

    /// Once a collection is ownerless, ANY caller may suspend a validator that would otherwise
    /// freeze every collector's token forever with nobody able to re-point it.
    function test_DeadManRelease_StrangerMaySuspendOnceOwnerless() public {
        _mintOne();
        validator.setRejectAll(true);

        // frozen while an owner exists, and the stranger has no power
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setTransferValidator(address(0));

        vm.prank(owner);
        nft.renounceOwnership();

        vm.prank(stranger);
        nft.setTransferValidator(address(0));
        assertEq(nft.getTransferValidator(), address(0), "suspended by a stranger");

        vm.prank(collector);
        nft.safeTransferFrom(collector, buyer, 0, 1, "");
        assertEq(nft.balanceOf(buyer, 0), 1, "the collector can move their token again");
    }

    /// Strictly asymmetric: toward transferability only. An ownerless collection can never be
    /// re-armed, so the release hands a stranger no power over a live project.
    function test_DeadManRelease_CannotReArm() public {
        vm.prank(owner);
        nft.renounceOwnership();

        vm.startPrank(stranger);
        nft.setTransferValidator(address(0)); // permitted
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setTransferValidator(address(validator2)); // never
        vm.stopPrank();
    }

    /// A no-change write is a no-op, not an event. The suspend path is permissionless once
    /// ownerless, so without the short-circuit a stranger could spam `TransferValidatorUpdated(0,0)`
    /// without bound and make this collection's log history unusable to an indexer.
    function test_DeadManRelease_RepeatSuspendEmitsNothing() public {
        vm.prank(owner);
        nft.renounceOwnership();
        vm.prank(stranger);
        nft.setTransferValidator(address(0));

        vm.recordLogs();
        vm.prank(stranger);
        nft.setTransferValidator(address(0));
        assertEq(vm.getRecordedLogs().length, 0, "a no-change suspend is silent");
    }

    // ---- the owner-managed validator lifecycle ----

    function test_SetTransferValidator_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setTransferValidator(address(validator2));
    }

    function test_SetTransferValidator_RepointsAndEnforcesNewOne() public {
        vm.prank(owner);
        nft.setTransferValidator(address(validator2));
        assertEq(nft.getTransferValidator(), address(validator2));

        _mintOne();
        validator.setRejectAll(true); // the old one no longer matters
        vm.prank(collector);
        nft.safeTransferFrom(collector, buyer, 0, 1, "");
        assertEq(validator2.callCount(), 1);
        assertEq(validator.callCount(), 0);
    }

    // ---- OneOfOneEdition enrollment smoke ----

    function test_OneOfOneEdition_Enrollment() public {
        OneOfOneEditionFactory f = new OneOfOneEditionFactory();
        OneOfOneEdition.InitParams memory p = OneOfOneEdition.InitParams({
            owner: owner,
            mintTo: collector,
            mintAmount: 1,
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
            transferValidator: address(validator),
            editionSize: 0,
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
        OneOfOneEdition one = OneOfOneEdition(f.deploy(p));
        assertTrue(one.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertEq(one.getTransferValidator(), address(validator));

        validator.setRejectAll(true);
        vm.prank(collector);
        vm.expectRevert(MockTransferValidator1155.TransferDenied.selector);
        one.safeTransferFrom(collector, buyer, 0, 1, "");
    }
}
