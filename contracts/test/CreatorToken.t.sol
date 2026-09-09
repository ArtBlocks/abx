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
import {CreatorToken} from "../src/extensions/creator-token/CreatorToken.sol";
import {ICreatorToken, ICreatorTokenLegacy} from "../src/interfaces/ICreatorToken.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev A validator that accepts by default and rejects everything when toggled — the toggle's
///      distinctive error is how tests prove the validator was (or wasn't) consulted, since the
///      token staticcalls `validateTransfer` (a view can record nothing). Exact-argument
///      assertions ride `vm.expectCall` instead.
contract MockTransferValidator {
    error TransferDenied();

    bool public rejectAll;

    function setRejectAll(bool value) external {
        rejectAll = value;
    }

    function validateTransfer(address, address, address, uint256) external view {
        if (rejectAll) revert TransferDenied();
    }
}

/// @notice Behavior of the opt-in ERC-721C creator-token extension: deploy-time permanent
///         enrollment (zero = plain ERC-721 forever), enrollment-gated ERC-165, stock transfer
///         validation semantics (mints/burns never validated, validator-initiated transfers
///         skip, reverts bubble), and the owner-managed validator lifecycle. Full suite on
///         SeriesImage; enrollment + blocked-transfer + unenrolled smoke on the other two types.
contract CreatorTokenTest is Test {
    // mirrored events for expectEmit
    event TransferValidatorUpdated(address oldValidator, address newValidator);

    SeriesImageFactory internal factory;
    SeriesImage internal nft; // enrolled with `validator` (the default in this suite)
    MockTransferValidator internal validator;
    MockTransferValidator internal validator2;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");
    address internal buyer = makeAddr("buyer");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant N = 5; // series size

    // protocol spec values, asserted independently of the implementation's own constants.
    // The interface ids are ecosystem-fixed literals (stock ERC-721C advertises both).
    bytes32 internal constant CREATOR_TOKEN_ID = keccak256("abx.extension.creator-token");
    bytes4 internal constant CREATOR_TOKEN_INTERFACE_ID = 0xad0d7f6c;
    bytes4 internal constant CREATOR_TOKEN_LEGACY_INTERFACE_ID = 0xa07d229a;
    bytes4 internal constant VALIDATE_TRANSFER_SELECTOR = 0xcaee23ea;

    function setUp() public {
        factory = new SeriesImageFactory();
        validator = new MockTransferValidator();
        validator2 = new MockTransferValidator();
        nft = _deploy(_params(address(validator)));
    }

    // ---- param builders ----

    function _params(address transferValidator)
        internal
        view
        returns (SeriesImage.InitParams memory)
    {
        return SeriesImage.InitParams({
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
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            mintTo: address(0),
            mintCount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    function _deploy(SeriesImage.InitParams memory p) internal returns (SeriesImage) {
        return SeriesImage(factory.deploy(p));
    }

    /// @dev Mint token 0 to `collector` on the enrolled series (mints are never validated).
    function _mintOne() internal {
        vm.prank(owner);
        nft.mint(collector);
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
            bytes32(bytes4(keccak256("validateTransfer(address,address,address,uint256)"))),
            bytes32(VALIDATE_TRANSFER_SELECTOR)
        );
    }

    // ---- unenrolled: a plain ERC-721, indistinguishable from a pre-721C token ----

    function test_Unenrolled_NoTrace() public {
        SeriesImage plain = _deploy(_params(address(0)));
        assertFalse(plain.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertFalse(plain.supportsInterface(CREATOR_TOKEN_LEGACY_INTERFACE_ID));
        assertEq(plain.extensionVersion(CREATOR_TOKEN_ID), 0);
        assertEq(plain.getTransferValidator(), address(0));
    }

    function test_Unenrolled_SetTransferValidatorRevertsEvenForOwner() public {
        SeriesImage plain = _deploy(_params(address(0)));
        vm.prank(owner);
        vm.expectRevert(CreatorToken.NotCreatorToken.selector);
        plain.setTransferValidator(address(validator));
    }

    function test_Unenrolled_TransfersFreely() public {
        SeriesImage plain = _deploy(_params(address(0)));
        vm.prank(owner);
        plain.mint(collector);
        vm.prank(collector);
        plain.transferFrom(collector, buyer, 0);
        assertEq(plain.ownerOf(0), buyer);
    }

    // ---- enrolled: discovery + deploy-time guarantees ----

    function test_Enrolled_Discovery() public view {
        assertTrue(nft.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertTrue(nft.supportsInterface(CREATOR_TOKEN_LEGACY_INTERFACE_ID));
        assertEq(nft.extensionVersion(CREATOR_TOKEN_ID), 1);
        assertEq(nft.getTransferValidator(), address(validator));
    }

    function test_Enrolled_ValidationFunctionIsTheViewValidateTransfer() public view {
        (bytes4 sig, bool isViewFunction) = nft.getTransferValidationFunction();
        assertEq(bytes32(sig), bytes32(VALIDATE_TRANSFER_SELECTOR));
        assertTrue(isViewFunction);
    }

    function test_Enrolled_DeployEmitsTransferValidatorUpdated() public {
        vm.expectEmit(false, false, false, true);
        emit TransferValidatorUpdated(address(0), address(validator));
        _deploy(_params(address(validator)));
    }

    function test_Deploy_RevertsCodelessValidator() public {
        SeriesImage.InitParams memory p = _params(makeAddr("codeless"));
        vm.expectRevert(CreatorToken.InvalidTransferValidator.selector);
        _deploy(p);
    }

    // ---- transfer semantics (stock CreatorTokenBase) ----

    function test_Mint_NeverValidated() public {
        // A reject-all validator can't brick minting: neither the deploy-time mint nor a
        // post-deploy mint consults the validator (from == 0x0 is skipped by design).
        validator.setRejectAll(true);
        SeriesImage.InitParams memory p = _params(address(validator));
        p.mintTo = owner;
        p.mintCount = 2;
        SeriesImage n = _deploy(p);
        assertEq(n.totalSupply(), 2);
        vm.prank(owner);
        n.mint(collector);
        assertEq(n.ownerOf(2), collector);
    }

    function test_DirectTransfer_CallsValidatorWithHolderAsCaller() public {
        _mintOne();
        vm.expectCall(
            address(validator),
            abi.encodeWithSelector(VALIDATE_TRANSFER_SELECTOR, collector, collector, buyer, 0)
        );
        vm.prank(collector);
        nft.transferFrom(collector, buyer, 0);
        assertEq(nft.ownerOf(0), buyer);
    }

    function test_OperatorTransfer_CallsValidatorWithOperatorAsCaller() public {
        _mintOne();
        vm.prank(collector);
        nft.setApprovalForAll(operator, true);
        vm.expectCall(
            address(validator),
            abi.encodeWithSelector(VALIDATE_TRANSFER_SELECTOR, operator, collector, buyer, 0)
        );
        vm.prank(operator);
        nft.transferFrom(collector, buyer, 0);
        assertEq(nft.ownerOf(0), buyer);
    }

    function test_ValidatorRevert_BlocksTransferAndBubbles() public {
        _mintOne();
        validator.setRejectAll(true);
        vm.prank(collector);
        vm.expectRevert(MockTransferValidator.TransferDenied.selector);
        nft.transferFrom(collector, buyer, 0);
        assertEq(nft.ownerOf(0), collector); // unmoved
    }

    function test_SuspendedValidator_TransfersPassWithNoCall() public {
        _mintOne();
        validator.setRejectAll(true); // would block if consulted
        vm.prank(owner);
        nft.setTransferValidator(address(0)); // suspend enforcement
        vm.prank(collector);
        nft.transferFrom(collector, buyer, 0);
        assertEq(nft.ownerOf(0), buyer);
        // suspended, not un-enrolled: the standard is still advertised
        assertTrue(nft.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertTrue(nft.supportsInterface(CREATOR_TOKEN_LEGACY_INTERFACE_ID));
        assertEq(nft.extensionVersion(CREATOR_TOKEN_ID), 1);
    }

    function test_ValidatorInitiatedTransfer_SkipsValidation() public {
        // The validator itself, acting as an approved operator, transfers without being asked
        // to validate its own action — even while rejecting everything.
        _mintOne();
        validator.setRejectAll(true);
        vm.prank(collector);
        nft.setApprovalForAll(address(validator), true);
        vm.prank(address(validator));
        nft.transferFrom(collector, buyer, 0);
        assertEq(nft.ownerOf(0), buyer);
    }

    // ---- the owner-managed validator lifecycle ----

    function test_SetTransferValidator_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setTransferValidator(address(validator2));
    }

    function test_SetTransferValidator_ZeroLegal_Emits() public {
        vm.expectEmit(false, false, false, true);
        emit TransferValidatorUpdated(address(validator), address(0));
        vm.prank(owner);
        nft.setTransferValidator(address(0));
        assertEq(nft.getTransferValidator(), address(0));
    }

    function test_SetTransferValidator_CodelessReverts() public {
        vm.prank(owner);
        vm.expectRevert(CreatorToken.InvalidTransferValidator.selector);
        nft.setTransferValidator(makeAddr("codeless"));
    }

    function test_SetTransferValidator_RepointsAndEnforcesNewOne() public {
        vm.expectEmit(false, false, false, true);
        emit TransferValidatorUpdated(address(validator), address(validator2));
        vm.prank(owner);
        nft.setTransferValidator(address(validator2));
        assertEq(nft.getTransferValidator(), address(validator2));

        // the new validator — not the old — is consulted from now on
        _mintOne();
        validator.setRejectAll(true); // the old one no longer matters
        vm.expectCall(
            address(validator2),
            abi.encodeWithSelector(VALIDATE_TRANSFER_SELECTOR, collector, collector, buyer, 0)
        );
        vm.prank(collector);
        nft.transferFrom(collector, buyer, 0);
        assertEq(nft.ownerOf(0), buyer);
    }

    function test_SetTransferValidator_ResumeAfterSuspend() public {
        vm.startPrank(owner);
        nft.setTransferValidator(address(0)); // suspend (stays enrolled)
        nft.setTransferValidator(address(validator2)); // resume with a new validator
        vm.stopPrank();
        assertEq(nft.getTransferValidator(), address(validator2));
        _mintOne();
        validator2.setRejectAll(true);
        vm.prank(collector);
        vm.expectRevert(MockTransferValidator.TransferDenied.selector);
        nft.transferFrom(collector, buyer, 0);
    }

    // ---- OneOfOneImage: enrollment + blocked transfer + unenrolled smoke ----

    function _oneOfOneParams(address transferValidator)
        internal
        view
        returns (OneOfOneImage.InitParams memory)
    {
        return OneOfOneImage.InitParams({
            owner: owner,
            mintTo: collector,
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
            transferValidator: transferValidator,
            tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    function test_OneOfOne_Enrollment() public {
        OneOfOneImageFactory f = new OneOfOneImageFactory();
        OneOfOneImage one = OneOfOneImage(f.deploy(_oneOfOneParams(address(validator))));
        assertTrue(one.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertTrue(one.supportsInterface(CREATOR_TOKEN_LEGACY_INTERFACE_ID));
        assertEq(one.extensionVersion(CREATOR_TOKEN_ID), 1);
        assertEq(one.getTransferValidator(), address(validator));

        validator.setRejectAll(true);
        vm.prank(collector);
        vm.expectRevert(MockTransferValidator.TransferDenied.selector);
        one.transferFrom(collector, buyer, 0);
    }

    function test_OneOfOne_UnenrolledSmoke() public {
        OneOfOneImageFactory f = new OneOfOneImageFactory();
        OneOfOneImage one = OneOfOneImage(f.deploy(_oneOfOneParams(address(0))));
        assertFalse(one.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertFalse(one.supportsInterface(CREATOR_TOKEN_LEGACY_INTERFACE_ID));
        assertEq(one.extensionVersion(CREATOR_TOKEN_ID), 0);
        vm.prank(owner);
        vm.expectRevert(CreatorToken.NotCreatorToken.selector);
        one.setTransferValidator(address(validator));
        vm.prank(collector);
        one.transferFrom(collector, buyer, 0);
        assertEq(one.ownerOf(0), buyer);
    }

    // ---- SeriesCode: enrollment + blocked transfer + unenrolled smoke ----

    function _seriesCodeParams(address transferValidator)
        internal
        view
        returns (SeriesCode.InitParams memory)
    {
        return SeriesCode.InitParams({
            owner: owner,
            name: "Waves",
            symbol: "WAV",
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
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            seedSource: address(0),
            disableTokenOwnerDelegation: false,
            mintTo: address(0),
            mintCount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    function test_SeriesCode_Enrollment() public {
        SeriesCodeFactory f = new SeriesCodeFactory();
        SeriesCode code = SeriesCode(f.deploy(_seriesCodeParams(address(validator))));
        assertTrue(code.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertTrue(code.supportsInterface(CREATOR_TOKEN_LEGACY_INTERFACE_ID));
        assertEq(code.extensionVersion(CREATOR_TOKEN_ID), 1);
        assertEq(code.getTransferValidator(), address(validator));

        vm.prank(owner);
        code.mint(collector); // mints are never validated
        validator.setRejectAll(true);
        vm.prank(collector);
        vm.expectRevert(MockTransferValidator.TransferDenied.selector);
        code.transferFrom(collector, buyer, 0);
    }

    function test_SeriesCode_UnenrolledSmoke() public {
        SeriesCodeFactory f = new SeriesCodeFactory();
        SeriesCode code = SeriesCode(f.deploy(_seriesCodeParams(address(0))));
        assertFalse(code.supportsInterface(CREATOR_TOKEN_INTERFACE_ID));
        assertFalse(code.supportsInterface(CREATOR_TOKEN_LEGACY_INTERFACE_ID));
        assertEq(code.extensionVersion(CREATOR_TOKEN_ID), 0);
        vm.prank(owner);
        vm.expectRevert(CreatorToken.NotCreatorToken.selector);
        code.setTransferValidator(address(validator));
        vm.prank(owner);
        code.mint(collector);
        vm.prank(collector);
        code.transferFrom(collector, buyer, 0);
        assertEq(code.ownerOf(0), buyer);
    }
}
