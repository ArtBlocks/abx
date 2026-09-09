// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {EditionCode} from "../src/tokens/EditionCode.sol";
import {EditionCodeFactory} from "../src/factories/EditionCodeFactory.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {
    IAbxConfigurableParams
} from "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {IAbxEditionMint} from "../src/interfaces/IAbxEditionMint.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Deterministic seed source recording every call — proves *when* it's consulted (once per
///      id's first mint, never again), mirroring `FixedSeedSource` in `SeriesCode.t.sol`.
contract RecordingSeedSource is IAbxSeedSource {
    uint256 public calls;
    mapping(uint256 => bytes32) public seedFor;

    function seed(uint256 tokenId, address to) external returns (bytes32) {
        ++calls;
        bytes32 s = keccak256(abi.encode(tokenId, to, calls));
        seedFor[tokenId] = s;
        return s;
    }
}

/// @notice Core behavior of a deployed code-project edition clone: the seed-on-FIRST-mint rule
///         (generalizing {SeriesCode}'s seed-on-mint to "first copy of this id"), the settled-seed
///         guard, and the ConfigurableParams TokenOwner leg generalized to "any holder" via the
///         adaptive {AbxParamsLib} auth probe. Mirrors the seed/params slice of
///         {SeriesCodeTest}'s scope.
contract EditionCodeTest is Test {
    event TokenParamConfigured(
        uint256 indexed tokenId,
        bytes32 indexed key,
        bytes32 value,
        bool valueIsHash,
        address indexed updatedBy
    );

    bytes32 internal constant SEED_KEY = "seed";
    bytes32 internal constant PALETTE_KEY = "palette";

    EditionCodeFactory internal factory;
    EditionCode internal nft;
    RecordingSeedSource internal source;

    address internal owner = makeAddr("owner");
    address internal collectorA = makeAddr("collectorA");
    address internal collectorB = makeAddr("collectorB");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant N = 5;

    function setUp() public {
        factory = new EditionCodeFactory();
        source = new RecordingSeedSource();
        nft = EditionCode(factory.deploy(_params()));
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
            royaltyReceiver: owner,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            maxInvocations: N,
            editionSize: 0,
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            seedSource: address(source),
            mintTo: address(0),
            mintCount: 0,
            mintAmount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    // ---- seed on FIRST mint of an id, never again ----

    function test_SeedDrawnOnFirstMintOfId() public {
        vm.prank(owner);
        nft.mint(collectorA, 0, 1);
        assertEq(source.calls(), 1);
        (bytes32 value, bool isHash, bool isSet) = nft.tokenParam(0, SEED_KEY);
        assertTrue(isSet);
        assertFalse(isHash);
        assertEq(value, source.seedFor(0));
    }

    function test_SeedNotRedrawnOnSecondMintSameId() public {
        vm.prank(owner);
        nft.mint(collectorA, 0, 1);
        (bytes32 firstSeed,,) = nft.tokenParam(0, SEED_KEY);

        vm.prank(owner);
        nft.mint(collectorB, 0, 4); // more copies of the SAME id
        assertEq(source.calls(), 1); // source consulted once, not twice
        (bytes32 stillSame,,) = nft.tokenParam(0, SEED_KEY);
        assertEq(stillSame, firstSeed);
    }

    function test_SeedsIndependentPerId() public {
        vm.prank(owner);
        nft.mint(collectorA, 0, 1);
        vm.prank(owner);
        nft.mint(collectorA, 1, 1);
        (bytes32 seed0,,) = nft.tokenParam(0, SEED_KEY);
        (bytes32 seed1,,) = nft.tokenParam(1, SEED_KEY);
        assertTrue(seed0 != seed1);
        assertEq(source.calls(), 2);
    }

    function test_NoSeedSourceMeansNoSeed() public {
        EditionCode.InitParams memory p = _params();
        p.seedSource = address(0);
        EditionCode n = EditionCode(factory.deploy(p));
        vm.prank(owner);
        n.mint(collectorA, 0, 1);
        (,, bool isSet) = n.tokenParam(0, SEED_KEY);
        assertFalse(isSet);
    }

    // ---- the settled-seed promise ----

    function test_SeedSettled_RawSetterReverts() public {
        vm.prank(owner);
        nft.mint(collectorA, 0, 1);
        vm.prank(owner);
        vm.expectRevert(EditionCode.SeedSettled.selector);
        nft.setTokenParam(0, SEED_KEY, bytes32("override"));
    }

    function test_CuratedSeedWinsOverSource() public {
        // creator pre-sets a curated seed for an id that has never been minted
        vm.prank(owner);
        nft.setTokenParam(0, SEED_KEY, bytes32("curated"));
        vm.prank(owner);
        nft.mint(collectorA, 0, 1);
        assertEq(source.calls(), 0); // the source never fills a gap that isn't there
        (bytes32 value,,) = nft.tokenParam(0, SEED_KEY);
        assertEq(value, bytes32("curated"));
    }

    // ---- mint guards ----

    function test_Mint_RevertsZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(EditionCode.ZeroMintAmount.selector);
        nft.mint(collectorA, 0, 0);
    }

    function test_Mint_RevertsExceedsIdSpace() public {
        vm.prank(owner);
        vm.expectRevert(); // MaxInvocations.MaxInvocationsReached — id == maxInvocations
        nft.mint(collectorA, N, 1);
    }

    function test_SupportsIAbxEditionMint() public view {
        assertTrue(nft.supportsInterface(type(IAbxEditionMint).interfaceId));
    }

    // ---- ConfigurableParams TokenOwner leg: generalizes to "any holder" on editions ----

    function test_TokenOwnerAuth_AnyHolderWithBalanceQualifies() public {
        vm.prank(owner);
        nft.mint(collectorA, 0, 5); // collectorA now holds copies of id 0

        vm.prank(owner);
        nft.setParamSchema(
            PALETTE_KEY,
            IAbxConfigurableParams.ParamType.HexColor,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );

        vm.expectEmit(true, true, false, true);
        emit TokenParamConfigured(0, PALETTE_KEY, bytes32(uint256(0xff0000)), false, collectorA);
        vm.prank(collectorA);
        nft.configureTokenParam(0, PALETTE_KEY, bytes32(uint256(0xff0000)));

        (bytes32 value,,) = nft.tokenParam(0, PALETTE_KEY);
        assertEq(value, bytes32(uint256(0xff0000)));
    }

    function test_TokenOwnerAuth_NonHolderReverts() public {
        vm.prank(owner);
        nft.mint(collectorA, 0, 5);
        vm.prank(owner);
        nft.setParamSchema(
            PALETTE_KEY,
            IAbxConfigurableParams.ParamType.HexColor,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );

        vm.prank(stranger); // holds 0 copies of id 0
        vm.expectRevert(); // NotParamAuthorized (thrown from the delegatecalled AbxParamsLib)
        nft.configureTokenParam(0, PALETTE_KEY, bytes32(uint256(0xff0000)));
    }

    // ---- honesty: the removed disableTokenOwnerDelegation knob (Fix 4b) ----

    /// `EditionCode.InitParams` no longer carries `disableTokenOwnerDelegation` — there is no
    /// delegation on the 1155 leg to disable (see the class-level dev note + `AbxParamsLib`'s
    /// `_isAuthorizedOwnerLeg`). Delegation must be structurally OFF: no `DelegateRegistrySet`
    /// event at deploy, and `delegateRegistry()` reads back `address(0)`.
    function test_Deploy_EmitsNoDelegateRegistrySet() public {
        vm.recordLogs();
        EditionCode n = EditionCode(factory.deploy(_params()));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != keccak256("DelegateRegistrySet(address)"));
        }
        assertEq(n.delegateRegistry(), address(0));
    }

    function test_TokenOwnerAuth_AnotherHolderAlsoQualifies_LastWriterWins() public {
        // Both collectors hold copies of the SAME id — either may configure it (shared state).
        vm.prank(owner);
        nft.mint(collectorA, 0, 3);
        vm.prank(owner);
        nft.mint(collectorB, 0, 2);
        vm.prank(owner);
        nft.setParamSchema(
            PALETTE_KEY,
            IAbxConfigurableParams.ParamType.HexColor,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );

        vm.prank(collectorA);
        nft.configureTokenParam(0, PALETTE_KEY, bytes32(uint256(0x00ff00)));
        vm.prank(collectorB); // a different holder of the SAME id — also qualifies
        nft.configureTokenParam(0, PALETTE_KEY, bytes32(uint256(0x0000ff)));

        (bytes32 value,,) = nft.tokenParam(0, PALETTE_KEY);
        assertEq(value, bytes32(uint256(0x0000ff))); // last writer wins
    }
}
