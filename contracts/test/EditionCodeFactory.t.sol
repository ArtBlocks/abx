// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "solady/utils/Initializable.sol";
import {LibString} from "solady/utils/LibString.sol";

import {EditionCode} from "../src/tokens/EditionCode.sol";
import {EditionCodeFactory} from "../src/factories/EditionCodeFactory.sol";
import {AbxVersion} from "../src/libraries/AbxVersion.sol";
import {EditionSupply} from "../src/extensions/edition-supply/EditionSupply.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {MaxInvocations} from "../src/extensions/max-invocations/MaxInvocations.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Minimal ERC-1155C validator: accepts everything, records the Permit-C token-type
///      registration — enough to prove {AbxEditionLib}'s enrollment/re-point/validate bodies
///      work identically to {CreatorToken1155}'s own inlined copy (exercised against
///      {EditionImage}/{OneOfOneEdition} in `test/CreatorToken1155.t.sol`).
contract MockValidator1155 {
    uint256 public tokenTypeRegistrations;

    function validateTransfer(address, address, address, uint256, uint256) external {}

    function setTokenTypeOfCollection(address, uint16) external {
        ++tokenTypeRegistrations;
    }
}

/// @notice Factory mechanics + the platform trust checks for the code-project edition twin. The
///         721 side has no dedicated `SeriesCodeFactory.t.sol` — this file is the one the plan
///         asked to do better on, covering the linked-library deploy path too (forge auto-links
///         {AbxParamsLib}/{AbxCodeLib}/{AbxEditionLib} for the implementation; a successful
///         `deploy()` exercising the params/script/URI/creator-token/supply extensions is itself
///         the proof every link resolved correctly).
contract EditionCodeFactoryTest is Test {
    // mirrored events for expectEmit
    event AbxDeployed(uint16 abxVersion);
    event AbxExtensionVersionSet(bytes32 indexed extensionId, uint16 version);
    event MaxInvocationsUpdated(uint256 maxInvocations);

    EditionCodeFactory internal factory;
    address internal owner = makeAddr("owner");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");

    bytes32 internal constant MAX_INVOCATIONS_ID = keccak256("abx.extension.max-invocations");
    bytes32 internal constant PARAMS_ID = keccak256("abx.extension.params");
    bytes32 internal constant CONFIGURABLE_PARAMS_ID =
        keccak256("abx.extension.configurable-params");
    bytes32 internal constant ONCHAIN_SCRIPT_ID = keccak256("abx.extension.onchain-script");
    bytes32 internal constant DEPENDENCIES_ID = keccak256("abx.extension.dependencies");

    function setUp() public {
        factory = new EditionCodeFactory();
    }

    function _params() internal view returns (EditionCode.InitParams memory) {
        return EditionCode.InitParams({
            owner: owner,
            name: "Waves",
            symbol: "WAV",
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
            seedSource: address(0),
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
        assertEq(EditionCode(clone).owner(), owner);
        assertEq(EditionCode(clone).maxInvocations(), 5);
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
        EditionCode.InitParams memory p = _params();
        p.maxInvocations = 0;
        vm.expectRevert(MaxInvocations.InvalidMaxInvocations.selector);
        factory.deploy(p);
    }

    function test_Deploy_RevertsMintCountExceedsMax() public {
        EditionCode.InitParams memory p = _params();
        p.mintTo = owner;
        p.mintCount = 6;
        p.mintAmount = 1;
        vm.expectRevert(EditionCode.MintCountExceedsMax.selector);
        factory.deploy(p);
    }

    function test_Implementation_CannotBeInitialized() public {
        EditionCode impl = EditionCode(factory.implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(_params());
    }

    // ---- library-link proof: the code-project extensions work end to end post-deploy ----

    function test_LinkedLibraries_ParamsAndScriptExtensionsWork() public {
        EditionCode clone = EditionCode(factory.deploy(_params()));
        // announced at init — proves AbxParamsLib-backed extensions initialized without reverting
        assertEq(clone.extensionVersion(PARAMS_ID), 2);
        assertEq(clone.extensionVersion(CONFIGURABLE_PARAMS_ID), 3); // v3: configure-hook blob args
        assertEq(clone.extensionVersion(ONCHAIN_SCRIPT_ID), 1);
        assertEq(clone.extensionVersion(DEPENDENCIES_ID), 1);

        // exercise the delegatecalled write paths (AbxParamsLib / AbxCodeLib) post-deploy
        vm.prank(owner);
        clone.setTokenParam(0, "palette", bytes32("blue"));
        (bytes32 value, bool isHash, bool isSet) = clone.tokenParam(0, "palette");
        assertEq(value, bytes32("blue"));
        assertFalse(isHash);
        assertTrue(isSet);

        vm.prank(owner);
        clone.setScriptChunk(0, "console.log(1)");
        assertEq(clone.scriptChunkCount(), 1);
    }

    // ---- AbxEditionLib link proof: EditionCode-only externalized 1155 surface (Fix 3) ----

    function test_LinkedLibraries_AbxEditionLibUriSurfaceWorks() public {
        EditionCode clone = EditionCode(factory.deploy(_params()));

        // derived uri() ladder (raw-forward delegatecall — see {EditionCode-uri}), identical
        // grammar to {Uri1155}'s inlined version: {base}/{chainId}/{address}/{id}
        string memory expected = string.concat(
            "https://abx.test/t",
            "/",
            LibString.toString(block.chainid),
            "/",
            LibString.toHexString(address(clone)),
            "/",
            LibString.toString(uint256(0))
        );
        assertEq(clone.uri(0), expected);

        // setTokenURIBase re-points the ladder; no automatic URI loop (Fix 2)
        vm.prank(owner);
        clone.setTokenURIBase("https://abx.test/t2");
        assertEq(clone.tokenURIBase(), "https://abx.test/t2");

        // setTokenURIOverride still auto-pings a single id, O(1)
        vm.prank(owner);
        clone.setTokenURIOverride(0, "ipfs://override");
        assertEq(clone.uri(0), "ipfs://override");

        // pingURI: the owner's re-index follow-up after a URI re-point. Owner-only so an arbitrary
        // caller cannot charge indexers `uri(id)` work for the price of an event.
        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        vm.prank(owner);
        clone.pingURI(ids);

        // lockTokenURI freezes the config
        vm.prank(owner);
        clone.lockTokenURI();
        assertTrue(clone.tokenURILocked());
        vm.prank(owner);
        vm.expectRevert(); // TokenURIConfigLocked (declared identically in AbxEditionLib)
        clone.setTokenURIBase("https://abx.test/t3");
    }

    function test_LinkedLibraries_AbxEditionLibCreatorTokenSurfaceWorks() public {
        MockValidator1155 validator = new MockValidator1155();
        EditionCode.InitParams memory p = _params();
        p.transferValidator = address(validator);
        EditionCode clone = EditionCode(factory.deploy(p));

        assertEq(clone.getTransferValidator(), address(validator));
        assertEq(validator.tokenTypeRegistrations(), 1); // enrollment registers the token type

        MockValidator1155 newValidator = new MockValidator1155();
        vm.prank(owner);
        clone.setTransferValidator(address(newValidator));
        assertEq(clone.getTransferValidator(), address(newValidator));
        assertEq(newValidator.tokenTypeRegistrations(), 1); // re-point registers again
    }

    function test_LinkedLibraries_AbxEditionLibSupplySurfaceWorks() public {
        EditionCode clone = EditionCode(factory.deploy(_params()));
        address collector = makeAddr("collector");

        vm.prank(owner);
        clone.setMaxSupply(0, 10);
        assertEq(clone.maxSupply(0), 10);

        vm.prank(owner);
        clone.mint(collector, 0, 10);
        vm.prank(owner);
        vm.expectRevert(EditionSupply.EditionSupplyReached.selector);
        clone.mint(collector, 0, 1);
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
        vm.expectRevert(EditionCodeFactory.SaltSenderMismatch.selector);
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
