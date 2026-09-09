// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "solady/utils/Initializable.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {AbxErc721Base} from "../src/core/AbxErc721Base.sol";
import {AbxVersion} from "../src/libraries/AbxVersion.sol";
import {CreatorToken} from "../src/extensions/creator-token/CreatorToken.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";

/// @dev A validator that answers ANY selector successfully — the shape {CreatorToken-_requireHasCode}
///      exists to reject. A contract like this enforces nothing while every read says a validator is
///      configured, which is worse than no validator at all: the collection reports enrolled and
///      transfers go unchecked.
contract PermissiveFallbackValidator {
    fallback() external payable {}
    receive() external payable {}
}

/// @dev A real-shaped validator: reverts on an unknown selector (what every live validator does),
///      accepts transfers, and records the Permit-C token-type registration.
contract MockValidator721 {
    uint256 public tokenTypeRegistrations;

    function validateTransfer(address, address, address) external view {}

    function setTokenTypeOfCollection(address, uint16) external {
        ++tokenTypeRegistrations;
    }
}

/// @notice The 721 code-project trust anchor, including linked-library behavior, owner validation,
///         permissive-fallback validator rejection, and Permit-C token-type registration.
contract SeriesCodeFactoryTest is Test {
    event AbxDeployed(uint16 abxVersion);

    SeriesCodeFactory internal factory;
    address internal owner = address(0xA11CE);
    address internal collector = address(0xB0B);

    function setUp() public {
        factory = new SeriesCodeFactory();
    }

    function _params() internal view returns (SeriesCode.InitParams memory p) {
        p.owner = owner;
        p.name = "Code";
        p.symbol = "CODE";
        p.royaltyReceiver = owner;
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        p.maxInvocations = 10;
        p.mintTo = collector;
        p.mintCount = 1;
    }

    // ── factory mechanics ───────────────────────────────────────────────────────────────────────

    function test_Deploy_RegistersClone() public {
        address clone = factory.deploy(_params());
        assertTrue(factory.isAbxClone(clone), "the factory is the trust anchor, not the beacon");
        assertEq(SeriesCode(clone).owner(), owner);
        assertEq(SeriesCode(clone).totalSupply(), 1, "the deploy-time mint landed");
    }

    function test_Deploy_EmitsTheBeacon() public {
        vm.expectEmit(false, false, false, true);
        emit AbxDeployed(AbxVersion.CORE_VERSION);
        factory.deploy(_params());
    }

    /// A clone from a DIFFERENT factory instance must not read as canonical — this is the whole
    /// authenticity story (`isAbxClone`, never the spoofable `AbxDeployed` event).
    function test_IsAbxClone_IsPerFactory() public {
        address clone = factory.deploy(_params());
        SeriesCodeFactory other = new SeriesCodeFactory();
        assertFalse(other.isAbxClone(clone), "another factory's clone is not this one's");
    }

    function test_Implementation_CannotBeInitialized() public {
        SeriesCode impl = SeriesCode(factory.implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(_params());
    }

    /// The linked libraries (`AbxParamsLib`, `AbxCodeLib`) are proven by USE: a deploy that
    /// exercises the params and script surfaces could not succeed if either link were unresolved,
    /// because an unlinked delegatecall lands at address zero and returns success with no effect.
    function test_LinkedLibraries_ParamsAndScriptSurfacesWork() public {
        SeriesCode clone = SeriesCode(factory.deploy(_params()));

        vm.startPrank(owner);
        clone.setTokenParam(0, "palette", bytes32(uint256(7)));
        clone.setScriptChunk(0, bytes("let x = 1;"));
        vm.stopPrank();

        (bytes32 v,, bool isSet) = clone.tokenParam(0, "palette");
        assertTrue(isSet, "params write reached storage");
        assertEq(v, bytes32(uint256(7)), "with the value written");
        assertEq(clone.scriptChunkCount(), 1, "script write reached storage");
        assertEq(clone.tokenParamKeys(0).length, 1, "and the enumeration stayed in step");
    }

    // ── security controls ──────────────────────────────────────────────────────────────────────

    /// `_initOwner` refuses `address(0)`. Without it a project could be born ownerless in ONE
    /// transaction — and an ownerless collection cannot be re-pointed, unpaused, or repaired by
    /// anyone.
    function test_InvalidOwner_ZeroOwnerIsRefusedAtDeploy() public {
        SeriesCode.InitParams memory p = _params();
        p.owner = address(0);
        vm.expectRevert(AbxErc721Base.InvalidOwner.selector);
        factory.deploy(p);
    }

    /// The validator probe rejects a contract whose fallback SUCCEEDS for an unknown selector.
    /// Such a contract enforces nothing while `getTransferValidator()` reports it as configured —
    /// the silent-bypass shape. Note what this does NOT catch, per `CreatorToken`'s own NatSpec: a
    /// validator that REVERTS on the probe selector passes, which includes a Safe deployed through
    /// the official factory.
    function test_PermissiveFallbackValidatorIsRefusedAtDeploy() public {
        SeriesCode.InitParams memory p = _params();
        p.transferValidator = address(new PermissiveFallbackValidator());
        vm.expectRevert(CreatorToken.InvalidTransferValidator.selector);
        factory.deploy(p);
    }

    function test_EoaValidatorIsRefusedAtDeploy() public {
        SeriesCode.InitParams memory p = _params();
        p.transferValidator = address(0xDEAD); // no code
        vm.expectRevert(CreatorToken.InvalidTransferValidator.selector);
        factory.deploy(p);
    }

    /// A real-shaped validator enrolls, and the collection registers its Permit-C token type — the
    /// conformance call stock `ERC721C` makes. It was dropped once to save 150 B of EIP-170 headroom
    /// and put back, because a remedy that depends on the owner knowing to perform it is not
    /// conformance.
    function test_RealValidatorEnrollsAndRegistersItsTokenType() public {
        MockValidator721 v = new MockValidator721();
        SeriesCode.InitParams memory p = _params();
        p.transferValidator = address(v);

        SeriesCode clone = SeriesCode(factory.deploy(p));
        assertEq(clone.getTransferValidator(), address(v), "enrolled");
        assertEq(v.tokenTypeRegistrations(), 1, "and told the validator it is a 721");
    }

    /// Enrollment is permanent-and-decided-at-deploy in BOTH directions: a collection deployed plain
    /// can never acquire enforcement. This is the claim `owner-powers.mdx` makes to buyers.
    function test_PlainCollectionCanNeverAcquireEnforcement() public {
        SeriesCode clone = SeriesCode(factory.deploy(_params())); // transferValidator = 0
        MockValidator721 v = new MockValidator721();

        vm.prank(owner);
        vm.expectRevert(CreatorToken.NotCreatorToken.selector);
        clone.setTransferValidator(address(v));
    }

    /// The dead-man release, on the 721 lane: while an owner exists this is owner-only; once the
    /// collection is ownerless anyone may SUSPEND, and only suspend. Asymmetric on purpose — an
    /// abandoned collection can only ever move toward transferability, never be re-armed.
    function test_DeadManRelease_SuspendOnlyAndOnlyWhenOwnerless() public {
        MockValidator721 v = new MockValidator721();
        SeriesCode.InitParams memory p = _params();
        p.transferValidator = address(v);
        SeriesCode clone = SeriesCode(factory.deploy(p));

        // while an owner exists: owner-only
        vm.prank(collector);
        vm.expectRevert();
        clone.setTransferValidator(address(0));

        vm.prank(owner);
        clone.renounceOwnership();

        // ownerless: a stranger may suspend...
        vm.prank(address(0xD00D));
        clone.setTransferValidator(address(0));
        assertEq(clone.getTransferValidator(), address(0), "suspended");

        // ...and may never re-arm
        vm.prank(address(0xD00D));
        vm.expectRevert();
        clone.setTransferValidator(address(v));
    }
}
