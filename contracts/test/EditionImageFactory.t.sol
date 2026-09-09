// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "solady/utils/Initializable.sol";

import {EditionImage} from "../src/tokens/EditionImage.sol";
import {EditionImageFactory} from "../src/factories/EditionImageFactory.sol";
import {AbxVersion} from "../src/libraries/AbxVersion.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {MaxInvocations} from "../src/extensions/max-invocations/MaxInvocations.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice Factory mechanics + the platform trust checks — the 1155 twin of
///         {SeriesImageFactoryTest} (the 721 side lacks a dedicated file for this factory; this
///         one is written from scratch mirroring {OneOfOneEditionFactoryTest}'s structure).
contract EditionImageFactoryTest is Test {
    // mirrored events for expectEmit
    event AbxDeployed(uint16 abxVersion);
    event AbxExtensionVersionSet(bytes32 indexed extensionId, uint16 version);
    event MaxInvocationsUpdated(uint256 maxInvocations);
    event Deployed(address indexed clone, address indexed implementation, address indexed owner);

    EditionImageFactory internal factory;
    address internal owner = makeAddr("owner");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");

    bytes32 internal constant MAX_INVOCATIONS_ID = keccak256("abx.extension.max-invocations");

    function setUp() public {
        factory = new EditionImageFactory();
    }

    function _params() internal view returns (EditionImage.InitParams memory) {
        return EditionImage.InitParams({
            owner: owner,
            name: "Postcards",
            symbol: "PC",
            tokenURIBase: "https://abx.test/t",
            tokenURIRenderer: address(0),
            contractURIBase: "https://abx.test/c",
            contractURIRenderer: address(0),
            royaltyReceiver: royaltyReceiver,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            maxInvocations: 5,
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

    function _saltFor(address who, uint96 entropy) internal pure returns (bytes32) {
        return bytes32(bytes20(who)) | bytes32(uint256(entropy));
    }

    function test_Deploy_RegistersClone() public {
        address clone = factory.deploy(_params());
        assertTrue(factory.isAbxClone(clone));
        assertEq(EditionImage(clone).owner(), owner);
        assertEq(EditionImage(clone).maxInvocations(), 5);
    }

    function test_Deploy_EmitsSpineThenDeployed() public {
        vm.expectEmit(false, false, false, true);
        emit AbxDeployed(AbxVersion.CORE_VERSION);
        vm.expectEmit(true, false, false, true);
        emit AbxExtensionVersionSet(MAX_INVOCATIONS_ID, 1);
        vm.expectEmit(false, false, false, true);
        emit MaxInvocationsUpdated(5);

        factory.deploy(_params());
    }

    function test_Deploy_RevertsZeroMaxInvocations() public {
        EditionImage.InitParams memory p = _params();
        p.maxInvocations = 0;
        vm.expectRevert(MaxInvocations.InvalidMaxInvocations.selector);
        factory.deploy(p);
    }

    function test_Deploy_RevertsMintCountExceedsMax() public {
        EditionImage.InitParams memory p = _params();
        p.mintTo = owner;
        p.mintCount = 6; // > maxInvocations (5)
        p.mintAmount = 1;
        vm.expectRevert(EditionImage.MintCountExceedsMax.selector);
        factory.deploy(p);
    }

    function test_Implementation_CannotBeInitialized() public {
        EditionImage impl = EditionImage(factory.implementation());
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
        vm.expectRevert(EditionImageFactory.SaltSenderMismatch.selector);
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

    function test_Deploy_WithMintCount_MintsEachIdAmount() public {
        EditionImage.InitParams memory p = _params();
        p.mintTo = owner;
        p.mintCount = 3;
        p.mintAmount = 4;
        EditionImage clone = EditionImage(factory.deploy(p));
        assertEq(clone.balanceOf(owner, 0), 4);
        assertEq(clone.balanceOf(owner, 1), 4);
        assertEq(clone.balanceOf(owner, 2), 4);
        assertEq(clone.totalSupply(0), 4);
        assertEq(clone.totalSupply(3), 0); // never minted
    }
}
