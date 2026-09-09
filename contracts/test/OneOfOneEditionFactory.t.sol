// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "solady/utils/Initializable.sol";

import {OneOfOneEdition} from "../src/tokens/OneOfOneEdition.sol";
import {OneOfOneEditionFactory} from "../src/factories/OneOfOneEditionFactory.sol";
import {AbxVersion} from "../src/libraries/AbxVersion.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice Factory mechanics + the platform trust checks (registry, codehash, determinism) —
///         the 1155 twin of {OneOfOneImageFactoryTest}.
contract OneOfOneEditionFactoryTest is Test {
    // mirrored events for expectEmit
    event AbxDeployed(uint16 abxVersion);
    event AbxExtensionVersionSet(bytes32 indexed extensionId, uint16 version);
    event RoyaltyChangedForAll(address indexed account, uint16 basisPoints);
    event ContractURIUpdated();
    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 amount
    );
    event Deployed(address indexed clone, address indexed implementation, address indexed owner);

    OneOfOneEditionFactory internal factory;
    address internal owner = makeAddr("owner");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");

    // protocol spec values, asserted independently of the implementation's own constants
    bytes32 internal constant ROYALTY_ID = keccak256("abx.extension.royalty");
    uint16 internal constant ROYALTY_VERSION = 2;

    function setUp() public {
        factory = new OneOfOneEditionFactory();
    }

    function _params() internal view returns (OneOfOneEdition.InitParams memory) {
        return OneOfOneEdition.InitParams({
            owner: owner,
            mintTo: owner,
            mintAmount: 1,
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
            editionSize: 0,
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
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
        assertEq(OneOfOneEdition(clone).owner(), owner);
        assertEq(OneOfOneEdition(clone).balanceOf(owner, 0), 1);
    }

    function test_Deploy_EmitsSpineThenDeployed() public {
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
        OneOfOneEdition.InitParams memory p = _params();
        p.royaltyReceiver = address(0); // with bps 500 -> would burn royalties
        vm.expectRevert(bytes4(keccak256("RoyaltyReceiverIsZeroAddress()")));
        factory.deploy(p);
    }

    function test_Implementation_CannotBeInitialized() public {
        OneOfOneEdition impl = OneOfOneEdition(factory.implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(_params());
    }

    // ---- trust checks ----

    function test_NonFactoryAddress_IsNotAbxClone() public {
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
        address predicted = factory.predictDeterministicAddress(salt);
        address clone = factory.deployDeterministic(_params(), salt);
        assertEq(clone, predicted);
        assertTrue(factory.isAbxClone(clone));
    }

    function test_DeployDeterministic_GuardBindsReservedSaltToSender() public {
        bytes32 salt = _saltFor(makeAddr("reserver"), 7);
        vm.expectRevert(OneOfOneEditionFactory.SaltSenderMismatch.selector);
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

    function test_Deploy_WithoutMint_RegistersButHoldsNoToken() public {
        OneOfOneEdition.InitParams memory p = _params();
        p.mintTo = address(0);
        p.mintAmount = 0;
        address clone = factory.deploy(p);
        assertTrue(factory.isAbxClone(clone));
        assertEq(OneOfOneEdition(clone).owner(), owner);
        assertEq(OneOfOneEdition(clone).balanceOf(owner, 0), 0);
    }
}
