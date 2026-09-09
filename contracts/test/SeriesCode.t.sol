// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {AbxSeedSource} from "../src/seed/AbxSeedSource.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {IAbxSeedSourceConfig} from "../src/extensions/seed-source/IAbxSeedSourceConfig.sol";
import {IAbxParams} from "../src/extensions/params/IAbxParams.sol";
import {IAbxConfigurableParams} from
    "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {IAbxOnChainScript} from "../src/extensions/onchain-script/IAbxOnChainScript.sol";
import {IAbxDependencies} from "../src/extensions/dependencies/IAbxDependencies.sol";
import {IAbxSequentialMint} from "../src/interfaces/IAbxSequentialMint.sol";
import {ConfigurableParams} from
    "../src/extensions/configurable-params/ConfigurableParams.sol";
import {AbxParamsLib} from "../src/libraries/AbxParamsLib.sol";
import {AbxCodeLib} from "../src/libraries/AbxCodeLib.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Deterministic seed source for assertions.
contract FixedSeedSource is IAbxSeedSource {
    bytes32 public next = bytes32(uint256(0xABCD));

    function seed(uint256 tokenId, address) external view returns (bytes32) {
        return keccak256(abi.encodePacked(next, tokenId));
    }
}

/// @dev Configure hook that vetoes any value equal to `banned`.
contract VetoConfigureHook {
    bytes32 public banned;
    uint256 public calls;

    constructor(bytes32 banned_) {
        banned = banned_;
    }

    function onParamConfigured(uint256, bytes32, bytes32 value, address, uint256, address) external {
        ++calls;
        require(value != banned, "vetoed");
    }
}

/// @dev Configure hook that RECORDS the two blob arguments and proves the pointer is live at hook
///      time by reading it back and hashing it. The whole point of passing an address instead of the
///      bytes is that a hook can do exactly this; if the blob were written after the hook, the read
///      below would not return the value (SSTORE2 sizes from `extcodesize - 1`, which underflows on
///      an empty account).
contract BlobInspectingConfigureHook {
    uint256 public lastLength;
    address public lastBlob;
    bytes32 public lastValue;
    bytes public lastReadBack;
    uint256 public maxLength = type(uint256).max;

    function setMaxLength(uint256 n) external {
        maxLength = n;
    }

    function onParamConfigured(
        uint256,
        bytes32,
        bytes32 value,
        address,
        uint256 dataLength,
        address dataBlobAddress
    ) external {
        lastValue = value;
        lastLength = dataLength;
        lastBlob = dataBlobAddress;
        if (dataBlobAddress != address(0)) lastReadBack = SSTORE2.read(dataBlobAddress);
        require(dataLength <= maxLength, "too big");
    }
}

/// @dev Transfer hook that records every notification.
contract RecordingTransferHook {
    struct Note {
        uint256 tokenId;
        address from;
        address to;
    }

    Note[] public notes;

    function onTokenTransfer(uint256 tokenId, address from, address to, address, uint256) external {
        notes.push(Note(tokenId, from, to));
    }

    function count() external view returns (uint256) {
        return notes.length;
    }
}

/// @dev Transfer hook that always reverts — must never block a transfer.
contract RevertingTransferHook {
    function onTokenTransfer(uint256, address, address, address, uint256) external pure {
        revert("nope");
    }
}

/// @dev Minimal delegate.xyz v2 stand-in: explicit (delegate, vault, tokenId) grants.
contract MockDelegateRegistry {
    mapping(bytes32 => bool) internal grants;

    function allow(address to, address from, uint256 tokenId) external {
        grants[keccak256(abi.encodePacked(to, from, tokenId))] = true;
    }

    function checkDelegateForERC721(address to, address from, address, uint256 tokenId, bytes32)
        external
        view
        returns (bool)
    {
        return grants[keccak256(abi.encodePacked(to, from, tokenId))];
    }
}

/// @notice Behavior of a deployed code-project clone: the seed lifecycle (draw at mint, curated
///         pre-set wins, settled once assigned), params + governed PostParams (schema, auth,
///         validation, locks, hooks), on-chain script + dependencies custody, and ERC-165.
contract SeriesCodeTest is Test {
    bytes32 internal constant SEED = "seed";
    bytes32 internal constant PALETTE = "palette";

    // mirrored events for expectEmit
    event TokenParamConfigured(
        uint256 indexed tokenId,
        bytes32 indexed key,
        bytes32 value,
        bool valueIsHash,
        address indexed updatedBy
    );
    event TokenParamCleared(uint256 indexed tokenId, bytes32 indexed key, address indexed updatedBy);
    event ContractParamConfigured(
        bytes32 indexed key, bytes32 value, bool valueIsHash, address indexed updatedBy
    );
    event ParamSchemaConfigured(
        bytes32 indexed key,
        IAbxConfigurableParams.ParamType paramType,
        IAbxConfigurableParams.AuthOption auth,
        address authAddress,
        uint48 lockAfter,
        bytes32 min,
        bytes32 max,
        string[] selectOptions
    );
    event HooksConfigured(address configureHook, address augmentHook, address transferHook);
    event DelegateRegistrySet(address indexed registry);
    event SeedSourceSet(address indexed seedSource);
    event ScriptUpdated(uint256 index);
    event ScriptLocked();
    event DependencyUpdated(
        uint256 index, IAbxDependencies.Resolution resolution, bytes32 indexed ref
    );
    event DependencyRemoved(uint256 index);

    SeriesCodeFactory internal factory;
    AbxSeedSource internal canonicalSource;
    FixedSeedSource internal fixedSource;
    SeriesCode internal nft;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant N = 5; // series size

    // protocol spec values, asserted independently of the implementation's own constants
    bytes32 internal constant PARAMS_ID = keccak256("abx.extension.params");
    bytes32 internal constant CONFIGURABLE_PARAMS_ID =
        keccak256("abx.extension.configurable-params");
    bytes32 internal constant ONCHAIN_SCRIPT_ID = keccak256("abx.extension.onchain-script");
    bytes32 internal constant DEPENDENCIES_ID = keccak256("abx.extension.dependencies");
    bytes32 internal constant SEED_SOURCE_ID = keccak256("abx.extension.seed-source");

    function setUp() public {
        factory = new SeriesCodeFactory();
        canonicalSource = new AbxSeedSource();
        fixedSource = new FixedSeedSource();
        nft = SeriesCode(factory.deploy(_params(address(fixedSource))));
    }

    function _params(address seedSource) internal view returns (SeriesCode.InitParams memory) {
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
            transferValidator: address(0),
            maxInvocations: N,
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            seedSource: seedSource,
            disableTokenOwnerDelegation: false,
            mintTo: address(0),
            mintCount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    // ---- initialization + discovery ----

    function test_InitialState() public view {
        assertEq(nft.owner(), owner);
        assertEq(nft.seedSource(), address(fixedSource));
        assertEq(nft.maxInvocations(), N);
        assertEq(nft.scriptChunkCount(), 0);
        assertEq(nft.dependencyCount(), 0);
        assertFalse(nft.scriptLocked());
        assertFalse(nft.dependenciesLocked());
    }

    function test_ExtensionsAnnounced() public view {
        assertEq(nft.extensionVersion(PARAMS_ID), 2); // v2: key enumeration
        // v3: the configure hook's calling convention gained dataLength + dataBlobAddress, so the
        // beacon version is how an integrator tells which form a deployed token will call.
        assertEq(nft.extensionVersion(CONFIGURABLE_PARAMS_ID), 3);
        assertEq(nft.extensionVersion(ONCHAIN_SCRIPT_ID), 1);
        assertEq(nft.extensionVersion(DEPENDENCIES_ID), 1);
        assertEq(nft.extensionVersion(SEED_SOURCE_ID), 1);
    }

    function test_Erc165SurfacesCodeProjectInterfaces() public view {
        assertTrue(nft.supportsInterface(type(IAbxParams).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxConfigurableParams).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxOnChainScript).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxDependencies).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxSeedSourceConfig).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxSequentialMint).interfaceId));
    }

    function test_FactoryRegistersClone() public view {
        assertTrue(factory.isAbxClone(address(nft)));
    }

    // ---- the seed lifecycle ----

    function test_MintAssignsSeedFromSource() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);

        (bytes32 value, bool isHash, bool isSet) = nft.tokenParam(id, SEED);
        assertTrue(isSet);
        assertFalse(isHash);
        assertEq(value, keccak256(abi.encodePacked(fixedSource.next(), id)));
    }

    function test_MintEmitsSeedWithSourceAsUpdatedBy() public {
        bytes32 expected = keccak256(abi.encodePacked(fixedSource.next(), uint256(0)));
        vm.expectEmit(true, true, true, true, address(nft));
        emit TokenParamConfigured(0, SEED, expected, false, address(fixedSource));
        vm.prank(owner);
        nft.mint(collector);
    }

    function test_SeedsDifferPerToken() public {
        vm.startPrank(owner);
        uint256 a = nft.mint(collector);
        uint256 b = nft.mint(collector);
        vm.stopPrank();
        (bytes32 sa,,) = nft.tokenParam(a, SEED);
        (bytes32 sb,,) = nft.tokenParam(b, SEED);
        assertTrue(sa != sb);
    }

    function test_NoSeedSourceMeansNoSeed() public {
        SeriesCode bare = SeriesCode(factory.deploy(_params(address(0))));
        vm.prank(owner);
        uint256 id = bare.mint(collector);
        (,, bool isSet) = bare.tokenParam(id, SEED);
        assertFalse(isSet);
    }

    function test_CuratedPresetSeedWins() public {
        bytes32 curated = bytes32(uint256(42));
        vm.prank(owner);
        nft.setTokenParam(0, SEED, curated); // pre-mint, creator-curated
        vm.prank(owner);
        nft.mint(collector);
        (bytes32 value,,) = nft.tokenParam(0, SEED);
        assertEq(value, curated); // the source fills gaps, never overwrites
    }

    function test_SeedSettledOnceAssigned() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);

        vm.prank(owner);
        vm.expectRevert(SeriesCode.SeedSettled.selector);
        nft.setTokenParam(id, SEED, bytes32(uint256(1)));

        vm.prank(owner);
        vm.expectRevert(SeriesCode.SeedSettled.selector);
        nft.clearTokenParam(id, SEED);
    }

    function test_SeedReconfigurableUnderExplicitSchema() public {
        // The schema is declared BEFORE any seed exists — the seed's governance model is a
        // pre-sale commitment, so a buyer can read `paramSchema("seed")` and know the work is
        // reassignable and by whom. Declaring it after the first seeded mint reverts `SeedSettled`
        // (see `test_SeedSchemaRefusedOnceASeedExists`), which is what stops a project changing
        // the terms on a token somebody already paid for.
        vm.prank(owner);
        nft.setParamSchema(
            SEED,
            IAbxConfigurableParams.ParamType.Uint256Range, // unbounded (min 0, max 0 = open above)
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );

        vm.prank(owner);
        uint256 id = nft.mint(collector);

        // raw owner path stays closed (now by the schema-governed rule)
        vm.prank(owner);
        vm.expectRevert(ConfigurableParams.SchemaGoverned.selector);
        nft.setTokenParam(id, SEED, bytes32(uint256(1)));

        // the governed path reassigns it to a value the caller chose, provenance = the token owner
        vm.prank(collector);
        nft.configureTokenParam(id, SEED, bytes32(uint256(777)));
        (bytes32 v,,) = nft.tokenParam(id, SEED);
        assertEq(v, bytes32(uint256(777)));
    }

    function test_SetSeedSourceAffectsFutureMintsOnly() public {
        vm.prank(owner);
        uint256 first = nft.mint(collector);
        (bytes32 before,,) = nft.tokenParam(first, SEED);

        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit SeedSourceSet(address(canonicalSource));
        nft.setSeedSource(address(canonicalSource));

        (bytes32 after_,,) = nft.tokenParam(first, SEED);
        assertEq(before, after_); // settled

        vm.prank(owner);
        uint256 second = nft.mint(collector);
        (,, bool isSet) = nft.tokenParam(second, SEED);
        assertTrue(isSet);
    }

    // ---- base params ----

    function test_OwnerSetsAndClearsTokenParam() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit TokenParamConfigured(1, PALETTE, bytes32(uint256(3)), false, owner);
        nft.setTokenParam(1, PALETTE, bytes32(uint256(3)));

        (bytes32 v, bool isHash, bool isSet) = nft.tokenParam(1, PALETTE);
        assertEq(v, bytes32(uint256(3)));
        assertFalse(isHash);
        assertTrue(isSet);

        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit TokenParamCleared(1, PALETTE, owner);
        nft.clearTokenParam(1, PALETTE);
        (,, isSet) = nft.tokenParam(1, PALETTE);
        assertFalse(isSet); // unset, not zero
    }

    function test_ZeroIsAValidValueDistinctFromUnset() public {
        vm.prank(owner);
        nft.setTokenParam(1, PALETTE, bytes32(0));
        (bytes32 v,, bool isSet) = nft.tokenParam(1, PALETTE);
        assertEq(v, bytes32(0));
        assertTrue(isSet);
    }

    function test_StrangerCannotSetParams() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setTokenParam(1, PALETTE, bytes32(uint256(3)));
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setContractParam(PALETTE, bytes32(uint256(3)));
    }

    function test_ContractParam() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit ContractParamConfigured(PALETTE, bytes32(uint256(7)), false, owner);
        nft.setContractParam(PALETTE, bytes32(uint256(7)));
        (bytes32 v,, bool isSet) = nft.contractParam(PALETTE);
        assertEq(v, bytes32(uint256(7)));
        assertTrue(isSet);
    }

    function test_DataParamHashesAndReadsBack() public {
        vm.prank(owner);
        nft.setTokenParamData(2, PALETTE, bytes("hello, world"));

        (bytes32 v, bool isHash, bool isSet) = nft.tokenParam(2, PALETTE);
        assertTrue(isSet);
        assertTrue(isHash);
        assertEq(v, keccak256("hello, world"));
        assertEq(nft.tokenParamData(2, PALETTE), bytes("hello, world"));

        // a literal write replaces the data-backed value and drops the blob
        vm.prank(owner);
        nft.setTokenParam(2, PALETTE, bytes32(uint256(1)));
        assertEq(nft.tokenParamData(2, PALETTE), bytes(""));
    }

    // ---- configurable params (PostParams) ----

    function _colorSchema(IAbxConfigurableParams.AuthOption auth, address authAddress, uint48 lockAfter)
        internal
    {
        vm.prank(owner);
        nft.setParamSchema(
            PALETTE,
            IAbxConfigurableParams.ParamType.HexColor,
            auth,
            authAddress,
            lockAfter,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
    }

    function test_SchemaEmitsInFull() public {
        string[] memory noOptions = new string[](0);
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit ParamSchemaConfigured(
            PALETTE,
            IAbxConfigurableParams.ParamType.HexColor,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            noOptions
        );
        nft.setParamSchema(
            PALETTE,
            IAbxConfigurableParams.ParamType.HexColor,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            noOptions
        );
    }

    function test_TokenOwnerConfiguresUnderSchema() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), 0);

        vm.prank(collector);
        vm.expectEmit(true, true, true, true, address(nft));
        emit TokenParamConfigured(id, PALETTE, bytes32(uint256(0x0E1A40)), false, collector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(0x0E1A40)));
    }

    function test_StrangerFailsSchemaAuth() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), 0);

        vm.prank(stranger);
        vm.expectRevert(AbxParamsLib.NotParamAuthorized.selector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(1)));
    }

    function test_CreatorAuthIsContractOwner() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.Creator, address(0), 0);

        vm.prank(collector); // token owner is NOT the creator here
        vm.expectRevert(AbxParamsLib.NotParamAuthorized.selector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(1)));

        vm.prank(owner);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(1)));
    }

    function test_AddressAuth() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.Address, stranger, 0);

        vm.prank(stranger);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(2)));
        (bytes32 v,,) = nft.tokenParam(id, PALETTE);
        assertEq(v, bytes32(uint256(2)));
    }

    function test_ValidationRejectsOutOfType() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), 0);

        vm.prank(collector);
        vm.expectRevert(AbxParamsLib.InvalidParamValue.selector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(0x1000000))); // > 0xFFFFFF
    }

    function test_SelectValidatesIndexBounds() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        string[] memory options = new string[](2);
        options[0] = "calm";
        options[1] = "storm";
        vm.prank(owner);
        nft.setParamSchema(
            "mood",
            IAbxConfigurableParams.ParamType.Select,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            options
        );

        vm.prank(collector);
        nft.configureTokenParam(id, "mood", bytes32(uint256(1)));

        vm.prank(collector);
        vm.expectRevert(AbxParamsLib.InvalidParamValue.selector);
        nft.configureTokenParam(id, "mood", bytes32(uint256(2)));
    }

    function test_LockAfterFreezesWrites() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        uint48 lockAt = uint48(block.timestamp + 1 days);
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), lockAt);

        vm.prank(collector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(1)));

        vm.warp(lockAt + 1);
        vm.prank(collector);
        vm.expectRevert(AbxParamsLib.ParamLockExpired.selector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(2)));
    }

    function test_SchemaClosesRawOwnerSetters() public {
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), 0);
        vm.prank(owner);
        vm.expectRevert(ConfigurableParams.SchemaGoverned.selector);
        nft.setTokenParam(0, PALETTE, bytes32(uint256(1)));
    }

    function test_StringParamUsesDataPath() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        vm.prank(owner);
        nft.setParamSchema(
            "title",
            IAbxConfigurableParams.ParamType.String,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );

        vm.prank(collector);
        vm.expectRevert(AbxParamsLib.WrongValuePath.selector);
        nft.configureTokenParam(id, "title", bytes32(uint256(1)));

        vm.prank(collector);
        nft.configureTokenParamData(id, "title", bytes("Dusk over the harbor"));
        (bytes32 v, bool isHash,) = nft.tokenParam(id, "title");
        assertTrue(isHash);
        assertEq(v, keccak256("Dusk over the harbor"));
        assertEq(nft.tokenParamData(id, "title"), bytes("Dusk over the harbor"));
    }

    function test_NoSchemaNoGovernedPath() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        vm.prank(collector);
        vm.expectRevert(AbxParamsLib.NoParamSchema.selector);
        nft.configureTokenParam(id, "unknown", bytes32(uint256(1)));
    }

    // ---- delegate.xyz on the TokenOwner leg ----

    function test_DefaultDelegateRegistryIsCanonicalV2() public view {
        assertEq(nft.delegateRegistry(), 0x00000000000000447e69651d841bD8D104Bed493);
    }

    function test_DelegateConfiguresAsTokenOwner() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), 0);

        MockDelegateRegistry registry = new MockDelegateRegistry();
        vm.prank(owner);
        nft.setDelegateRegistry(address(registry));
        registry.allow(stranger, collector, id); // collector's vault delegates to `stranger`

        vm.prank(stranger);
        vm.expectEmit(true, true, true, true, address(nft));
        emit TokenParamConfigured(id, PALETTE, bytes32(uint256(0x336699)), false, stranger);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(0x336699)));
    }

    function test_NonDelegateStillFailsAuth() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), 0);

        MockDelegateRegistry registry = new MockDelegateRegistry();
        vm.prank(owner);
        nft.setDelegateRegistry(address(registry)); // no grant for `stranger`

        vm.prank(stranger);
        vm.expectRevert(AbxParamsLib.NotParamAuthorized.selector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(1)));
    }

    function test_MissingRegistryCodeFailsClosedNotLoud() public {
        // the canonical address has no code on this local chain: the delegation leg must be a
        // silent "not delegated", never a revert — and the direct owner path must still work.
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), 0);

        vm.prank(stranger);
        vm.expectRevert(AbxParamsLib.NotParamAuthorized.selector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(1)));

        vm.prank(collector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(2)));
    }

    function test_DelegationOptOutAtDeploy() public {
        SeriesCode.InitParams memory p = _params(address(fixedSource));
        p.disableTokenOwnerDelegation = true;
        SeriesCode noDelegation = SeriesCode(factory.deploy(p));
        assertEq(noDelegation.delegateRegistry(), address(0));
    }

    function test_OwnerRepointsOrDisablesRegistry() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setDelegateRegistry(address(0));

        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit DelegateRegistrySet(address(0));
        nft.setDelegateRegistry(address(0));
        assertEq(nft.delegateRegistry(), address(0));
    }

    // ---- hooks ----

    function test_ConfigureHookVetoes() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), 0);

        VetoConfigureHook hook = new VetoConfigureHook(bytes32(uint256(0xBAD)));
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit HooksConfigured(address(hook), address(0), address(0));
        nft.setParamHooks(address(hook), address(0), address(0));

        vm.prank(collector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(0x00CC66)));
        assertEq(hook.calls(), 1);

        vm.prank(collector);
        vm.expectRevert(bytes("vetoed"));
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(0xBAD)));
    }

    /// The blob arguments exist so a hook can inspect content WITHOUT the bytes riding in calldata.
    /// This asserts every part of that contract on a real `String` write: the length, the pointer,
    /// the `keccak256(SSTORE2.read(blob)) == value` invariant, and — the load-bearing one — that the
    /// pointer is already LIVE when the hook runs. It is also the regression guard for the ordering:
    /// move `SSTORE2.write` back after the hook and the read-back below stops matching.
    function test_ConfigureHookSeesTheBlobLengthAndLivePointer() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        vm.prank(owner);
        nft.setParamSchema(
            "title",
            IAbxConfigurableParams.ParamType.String,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        BlobInspectingConfigureHook hook = new BlobInspectingConfigureHook();
        vm.prank(owner);
        nft.setParamHooks(address(hook), address(0), address(0));

        bytes memory body = bytes("Dusk over the harbor");
        vm.prank(collector);
        nft.configureTokenParamData(id, "title", body);

        assertEq(hook.lastLength(), body.length, "dataLength is the blob's length");
        assertTrue(hook.lastBlob() != address(0), "blob pointer is passed");
        assertEq(hook.lastValue(), keccak256(body), "value is the content hash");
        // read back INSIDE the hook — proves the pointer was live at hook time
        assertEq(hook.lastReadBack(), body, "SSTORE2.read(blob) returned the bytes during the hook");
        assertEq(keccak256(hook.lastReadBack()), hook.lastValue(), "the documented invariant holds");
        // and the pointer the hook saw is the one that persisted
        assertEq(nft.tokenParamData(id, "title"), body);
    }

    /// The scalar path zeroes both blob arguments, and `dataLength == 0` is therefore a reliable
    /// discriminator — an empty blob is refused before the hook, so the data path can never pass 0.
    function test_ConfigureHookScalarPathZeroesTheBlobArguments() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        _colorSchema(IAbxConfigurableParams.AuthOption.TokenOwner, address(0), 0);
        BlobInspectingConfigureHook hook = new BlobInspectingConfigureHook();
        vm.prank(owner);
        nft.setParamHooks(address(hook), address(0), address(0));

        vm.prank(collector);
        nft.configureTokenParam(id, PALETTE, bytes32(uint256(0x00CC66)));

        assertEq(hook.lastLength(), 0, "scalar writes pass dataLength 0");
        assertEq(hook.lastBlob(), address(0), "scalar writes pass no blob");
        assertEq(hook.lastValue(), bytes32(uint256(0x00CC66)), "the literal rides in `value`");
    }

    /// The point of the whole change: a creator can now police blob size in their OWN hook instead of
    /// the protocol imposing a ceiling on every project. A vetoed write persists nothing.
    function test_ConfigureHookCanEnforceItsOwnSizeCeiling() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        vm.prank(owner);
        nft.setParamSchema(
            "title",
            IAbxConfigurableParams.ParamType.String,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        BlobInspectingConfigureHook hook = new BlobInspectingConfigureHook();
        hook.setMaxLength(8);
        vm.prank(owner);
        nft.setParamHooks(address(hook), address(0), address(0));

        vm.prank(collector);
        vm.expectRevert(bytes("too big"));
        nft.configureTokenParamData(id, "title", bytes("this is far longer than eight bytes"));
        assertEq(nft.tokenParamData(id, "title").length, 0, "a vetoed write persists nothing");

        vm.prank(collector);
        nft.configureTokenParamData(id, "title", bytes("tiny"));
        assertEq(nft.tokenParamData(id, "title"), bytes("tiny"));
    }

    function test_TransferHookObservesMintAndTransfer() public {
        RecordingTransferHook hook = new RecordingTransferHook();
        vm.prank(owner);
        nft.setParamHooks(address(0), address(0), address(hook));

        vm.prank(owner);
        uint256 id = nft.mint(collector); // mint = transfer from 0x0
        vm.prank(collector);
        nft.transferFrom(collector, stranger, id);

        assertEq(hook.count(), 2);
        (uint256 tid, address from, address to) = hook.notes(0);
        assertEq(tid, id);
        assertEq(from, address(0));
        assertEq(to, collector);
        (, from, to) = hook.notes(1);
        assertEq(from, collector);
        assertEq(to, stranger);
    }

    /// @dev A transfer hook is a VETO: its revert bubbles and blocks the transfer. This used to
    ///      swallow the revert and promise the lifecycle could never block a transfer — a promise
    ///      that could not be kept, because Solady runs the receiver acceptance check after the hook,
    ///      so the `safe*` variants had work left afterwards for a hook to starve. The honest shape
    ///      is a creator-controlled veto that is visible, plus a lock that lets a project give the
    ///      power up provably.
    function test_RevertingTransferHookBlocksTransfersAndMints() public {
        // Mint FIRST: the notification fires on mint too (`from == 0x0`), so once the hook is armed
        // it vetoes issuance as well. That is the honest consequence of a veto and is documented.
        vm.prank(owner);
        uint256 id = nft.mint(collector);

        RevertingTransferHook hook = new RevertingTransferHook();
        vm.prank(owner);
        nft.setParamHooks(address(0), address(0), address(hook));

        vm.prank(collector);
        vm.expectRevert(); // the hook's own revert, bubbled
        nft.transferFrom(collector, stranger, id);
        assertEq(nft.ownerOf(id), collector, "the veto held the token in place");

        // and the same veto stops further issuance on this project
        vm.prank(owner);
        vm.expectRevert();
        nft.mint(collector);
    }

    /// @dev The commitment that makes the veto acceptable: a project can freeze its hook set, so a
    ///      buyer reading `paramHooks()` knows which contracts can ever run on their token.
    function test_LockParamHooksIsOneWayAndClosesEveryChange() public {
        RecordingTransferHook hook = new RecordingTransferHook();
        vm.startPrank(owner);
        nft.setParamHooks(address(0), address(0), address(hook));
        nft.lockParamHooks();

        vm.expectRevert(AbxParamsLib.ParamHooksLocked.selector);
        nft.setParamHooks(address(0), address(0), address(0)); // cannot clear
        vm.expectRevert(AbxParamsLib.ParamHooksLocked.selector);
        nft.setParamHooks(address(0), address(0), address(hook)); // cannot re-set the same thing
        vm.stopPrank();

        (,, address transferHook) = nft.paramHooks();
        assertEq(transferHook, address(hook), "the frozen set is what a buyer reads");
    }

    function test_LockParamHooksIsOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.lockParamHooks();
    }

    // ---- on-chain script ----

    function test_ScriptChunkLifecycle() public {
        vm.startPrank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit ScriptUpdated(0);
        nft.setScriptChunk(0, bytes("let x = 1;"));
        nft.setScriptChunk(1, bytes("draw(x);"));
        assertEq(nft.scriptChunkCount(), 2);
        assertEq(nft.scriptChunk(0), bytes("let x = 1;"));
        assertEq(nft.scriptChunk(1), bytes("draw(x);"));

        nft.setScriptChunk(0, bytes("let x = 2;")); // replace in place
        assertEq(nft.scriptChunk(0), bytes("let x = 2;"));

        nft.removeLastScriptChunk();
        assertEq(nft.scriptChunkCount(), 1);

        vm.expectRevert(AbxCodeLib.ScriptIndexOutOfRange.selector);
        nft.setScriptChunk(5, bytes("x")); // sparse writes are not a thing
        vm.stopPrank();
    }

    function test_ScriptLockFreezesForever() public {
        vm.startPrank(owner);
        nft.setScriptChunk(0, bytes("let x = 1;"));
        vm.expectEmit(true, true, true, true, address(nft));
        emit ScriptLocked();
        nft.lockScript();

        vm.expectRevert(AbxCodeLib.ScriptIsLocked.selector);
        nft.setScriptChunk(0, bytes("let x = 2;"));
        vm.expectRevert(AbxCodeLib.ScriptIsLocked.selector);
        nft.removeLastScriptChunk();
        vm.stopPrank();
    }

    function test_StrangerCannotTouchScript() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setScriptChunk(0, bytes("x"));
    }

    // ---- dependencies ----

    function test_DependencyLifecycle() public {
        vm.startPrank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit DependencyUpdated(0, IAbxDependencies.Resolution.Registry, bytes32("p5js@1.9.0"));
        nft.setDependency(0, IAbxDependencies.Resolution.Registry, bytes32("p5js@1.9.0"));
        nft.setDependency(1, IAbxDependencies.Resolution.OnChain, bytes32(bytes20(address(0xCAFE))));
        assertEq(nft.dependencyCount(), 2);

        (IAbxDependencies.Resolution res, bytes32 ref) = nft.dependencyByIndex(0);
        assertEq(uint8(res), uint8(IAbxDependencies.Resolution.Registry));
        assertEq(ref, bytes32("p5js@1.9.0"));

        vm.expectEmit(true, true, true, true, address(nft));
        emit DependencyRemoved(1);
        nft.removeLastDependency();
        assertEq(nft.dependencyCount(), 1);

        nft.setDependencyRegistry(address(0xBEEF));
        assertEq(nft.dependencyRegistry(), address(0xBEEF));

        nft.lockDependencies();
        assertTrue(nft.dependenciesLocked());
        vm.expectRevert(AbxCodeLib.DependenciesAreLocked.selector);
        nft.setDependency(1, IAbxDependencies.Resolution.Registry, bytes32("threejs@0.150.0"));
        vm.stopPrank();
    }

    // ---- mint auth parity with SeriesImage ----

    function test_PausedBlocksNonOwnerMint() public {
        SeriesCode.InitParams memory p = _params(address(fixedSource));
        p.paused = true;
        p.minter = stranger;
        SeriesCode pausedNft = SeriesCode(factory.deploy(p));

        vm.prank(stranger);
        vm.expectRevert(SeriesCode.MintingPaused.selector);
        pausedNft.mint(collector);

        vm.prank(owner); // owner always may
        pausedNft.mint(collector);
    }

    function test_SoldOutReverts() public {
        vm.startPrank(owner);
        for (uint256 i; i < N; ++i) {
            nft.mint(collector);
        }
        vm.expectRevert();
        nft.mint(collector);
        vm.stopPrank();
    }
}
