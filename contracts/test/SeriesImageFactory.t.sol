// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "solady/utils/Initializable.sol";

import {SeriesImage} from "../src/tokens/SeriesImage.sol";
import {SeriesImageFactory} from "../src/factories/SeriesImageFactory.sol";
import {AbxVersion} from "../src/libraries/AbxVersion.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice Series factory mechanics + platform trust checks (registry, codehash, determinism) —
///         the exact sibling of the 1/1 factory suite.
contract SeriesImageFactoryTest is Test {
    // mirrored events for expectEmit
    event AbxDeployed(uint16 abxVersion);
    event AbxExtensionVersionSet(bytes32 indexed extensionId, uint16 version);
    event MaxInvocationsUpdated(uint256 maxInvocations);
    event Deployed(address indexed clone, address indexed implementation, address indexed owner);

    SeriesImageFactory internal factory;
    address internal owner = makeAddr("owner");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");

    bytes32 internal constant MAX_INVOCATIONS_ID = keccak256("abx.extension.max-invocations");

    function setUp() public {
        factory = new SeriesImageFactory();
    }

    function _params() internal view returns (SeriesImage.InitParams memory) {
        return SeriesImage.InitParams({
            owner: owner,
            name: "Postcards",
            symbol: "PC",
            tokenURIBase: "ipfs://token",
            tokenURIRenderer: address(0),
            contractURIBase: "ipfs://contract",
            contractURIRenderer: address(0),
            royaltyReceiver: royaltyReceiver,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            maxInvocations: 10,
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            mintTo: address(0),
            mintCount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    /// @dev A salt reserved to `who`: leading 20 bytes = the address, trailing 12 = entropy.
    function _saltFor(address who, uint96 entropy) internal pure returns (bytes32) {
        return bytes32(bytes20(who)) | bytes32(uint256(entropy));
    }

    function test_Deploy_RegistersClone() public {
        address clone = factory.deploy(_params());
        assertTrue(factory.isAbxClone(clone));
        assertEq(SeriesImage(clone).owner(), owner);
        assertEq(SeriesImage(clone).maxInvocations(), 10);
    }

    function test_Deploy_EmitsSpineThenDeployed() public {
        vm.expectEmit(false, false, false, true);
        emit AbxDeployed(AbxVersion.CORE_VERSION);
        vm.expectEmit(true, false, false, true);
        emit AbxExtensionVersionSet(MAX_INVOCATIONS_ID, 1);
        vm.expectEmit(false, false, false, true);
        emit MaxInvocationsUpdated(10);
        vm.expectEmit(false, true, true, false); // clone address unknown pre-deploy
        emit Deployed(address(0), factory.implementation(), owner);

        factory.deploy(_params());
    }

    function test_Implementation_CannotBeInitialized() public {
        SeriesImage impl = SeriesImage(factory.implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(_params());
    }

    function test_NonFactoryAddress_IsNotAbxClone() public {
        assertFalse(factory.isAbxClone(makeAddr("imposter")));
        assertFalse(factory.isAbxClone(factory.implementation()));
        address clone = factory.deploy(_params());
        assertTrue(factory.isAbxClone(clone));
    }

    function test_AllClonesRunIdenticalCode() public {
        address a = factory.deploy(_params());
        address b = factory.deploy(_params());
        assertEq(a.codehash, b.codehash);
        assertTrue(a.codehash != factory.implementation().codehash);
    }

    function test_DeployDeterministic_PredictMatches() public {
        bytes32 salt = _saltFor(address(this), 1);
        address predicted = factory.predictDeterministicAddress(salt);
        address clone = factory.deployDeterministic(_params(), salt);
        assertEq(clone, predicted);
        assertTrue(factory.isAbxClone(clone));
    }

    function test_DeployDeterministic_GuardBindsReservedSaltToSender() public {
        bytes32 salt = _saltFor(makeAddr("reserver"), 7);
        vm.expectRevert(SeriesImageFactory.SaltSenderMismatch.selector);
        factory.deployDeterministic(_params(), salt);

        vm.prank(makeAddr("reserver"));
        address clone = factory.deployDeterministic(_params(), salt);
        assertEq(clone, factory.predictDeterministicAddress(salt));
    }

    function test_DeployDeterministic_SameSaltReverts() public {
        bytes32 salt = _saltFor(address(this), 42);
        factory.deployDeterministic(_params(), salt);
        vm.expectRevert();
        factory.deployDeterministic(_params(), salt);
    }
}
