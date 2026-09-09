// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "solady/utils/Initializable.sol";

import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {AbxVersion} from "../src/libraries/AbxVersion.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice Factory mechanics + the platform trust checks (registry, codehash, determinism).
contract OneOfOneImageFactoryTest is Test {
    // mirrored events for expectEmit
    event AbxDeployed(uint16 abxVersion);
    event AbxExtensionVersionSet(bytes32 indexed extensionId, uint16 version);
    event RoyaltyChangedForAll(address indexed account, uint16 basisPoints);
    event ContractURIUpdated();
    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Deployed(address indexed clone, address indexed implementation, address indexed owner);

    OneOfOneImageFactory internal factory;
    address internal owner = makeAddr("owner");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");

    // protocol spec values, asserted independently of the implementation's own constants
    bytes32 internal constant ROYALTY_ID = keccak256("abx.extension.royalty");
    uint16 internal constant ROYALTY_VERSION = 2;

    function setUp() public {
        factory = new OneOfOneImageFactory();
    }

    function _params() internal view returns (OneOfOneImage.InitParams memory) {
        return OneOfOneImage.InitParams({
            owner: owner,
            mintTo: owner,
            name: "Sunrise",
            symbol: "SUN",
            tokenURIBase: "ipfs://token",
            tokenURIRenderer: address(0),
            contractURIBase: "ipfs://contract",
            contractURIRenderer: address(0),
            royaltyReceiver: royaltyReceiver,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    /// @dev A salt reserved to `who`: leading 20 bytes = the address (the access
    ///      guard), trailing 12 bytes = entropy. Mirrors the SDK's `saltFor`.
    function _saltFor(address who, uint96 entropy) internal pure returns (bytes32) {
        return bytes32(bytes20(who)) | bytes32(uint256(entropy));
    }

    function test_Deploy_RegistersClone() public {
        address clone = factory.deploy(_params());
        assertTrue(factory.isAbxClone(clone));
        assertEq(OneOfOneImage(clone).owner(), owner);
        assertEq(OneOfOneImage(clone).ownerOf(0), owner);
    }

    function test_Deploy_EmitsSpineThenDeployed() public {
        // The clone announces itself (beacon → version → royalty → contractURI → mint),
        // then the factory ratifies with Deployed. Assert the headline events + order.
        vm.expectEmit(false, false, false, true);
        emit AbxDeployed(AbxVersion.CORE_VERSION);
        vm.expectEmit(true, false, false, true);
        emit AbxExtensionVersionSet(ROYALTY_ID, ROYALTY_VERSION);
        vm.expectEmit(true, false, false, true);
        emit RoyaltyChangedForAll(royaltyReceiver, 500);
        vm.expectEmit(false, false, false, true);
        emit ContractURIUpdated();

        factory.deploy(_params());
    }

    function test_Deploy_RevertsZeroRoyaltyReceiverWithBps() public {
        OneOfOneImage.InitParams memory p = _params();
        p.royaltyReceiver = address(0); // with bps 500 -> would burn royalties
        vm.expectRevert(bytes4(keccak256("RoyaltyReceiverIsZeroAddress()")));
        factory.deploy(p);
    }

    function test_Implementation_CannotBeInitialized() public {
        OneOfOneImage impl = OneOfOneImage(factory.implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(_params());
    }

    // ---- trust checks ----

    function test_NonFactoryAddress_IsNotAbxClone() public {
        // The trust check: arbitrary addresses (even ones spoofing the spine) are not clones.
        assertFalse(factory.isAbxClone(makeAddr("imposter")));
        assertFalse(factory.isAbxClone(factory.implementation()));
        address clone = factory.deploy(_params());
        assertTrue(factory.isAbxClone(clone));
    }

    function test_AllClonesRunIdenticalCode() public {
        // EIP-1167 property: every clone shares one runtime codehash, distinct from the impl.
        address a = factory.deploy(_params());
        address b = factory.deploy(_params());
        assertEq(a.codehash, b.codehash);
        assertTrue(a.codehash != factory.implementation().codehash);
    }

    function test_DeployDeterministic_PredictMatches() public {
        bytes32 salt = _saltFor(address(this), 1);
        // The predicted address is a pure function of the salt — no deployer arg.
        address predicted = factory.predictDeterministicAddress(salt);
        address clone = factory.deployDeterministic(_params(), salt);
        assertEq(clone, predicted);
        assertTrue(factory.isAbxClone(clone));
    }

    function test_DeployDeterministic_GuardBindsReservedSaltToSender() public {
        // A salt whose leading 20 bytes name someone else can't be used by us:
        // front-running protection for a pre-computed (reserved) address.
        bytes32 salt = _saltFor(makeAddr("reserver"), 7);
        vm.expectRevert(OneOfOneImageFactory.SaltSenderMismatch.selector);
        factory.deployDeterministic(_params(), salt);

        // The reserver themselves can deploy it.
        vm.prank(makeAddr("reserver"));
        address clone = factory.deployDeterministic(_params(), salt);
        assertEq(clone, factory.predictDeterministicAddress(salt));
    }

    function test_DeployDeterministic_PermissionlessSaltIsCallerIndependent() public {
        // All-zero leading bytes ⇒ anyone may deploy, and the address is the same
        // regardless of who sends it (a shared, canonical deployment).
        bytes32 salt = bytes32(uint256(0xABCD)); // zero prefix
        address predicted = factory.predictDeterministicAddress(salt);
        vm.prank(makeAddr("anyone"));
        address clone = factory.deployDeterministic(_params(), salt);
        assertEq(clone, predicted);
        assertTrue(factory.isAbxClone(clone));
    }

    function test_DeployDeterministic_SameSaltReverts() public {
        bytes32 salt = _saltFor(address(this), 42);
        factory.deployDeterministic(_params(), salt);
        vm.expectRevert(); // address already has code (create2 collision)
        factory.deployDeterministic(_params(), salt);
    }

    function test_Deploy_WithoutMint_RegistersButHoldsNoToken() public {
        OneOfOneImage.InitParams memory p = _params();
        p.mintTo = address(0);
        address clone = factory.deploy(p);
        assertTrue(factory.isAbxClone(clone));
        assertEq(OneOfOneImage(clone).owner(), owner);
        assertEq(OneOfOneImage(clone).balanceOf(owner), 0);
    }
}
