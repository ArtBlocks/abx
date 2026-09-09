// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {EditionCode} from "../src/tokens/EditionCode.sol";
import {EditionCodeFactory} from "../src/factories/EditionCodeFactory.sol";
import {AbxSeedSource} from "../src/seed/AbxSeedSource.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {IAbxConfigurableParams} from
    "../src/extensions/configurable-params/IAbxConfigurableParams.sol";

/// @dev A seed source that re-enters the token's own mint while it is mid-mint. This is the
///      shape that used to oversell an edition: `IAbxSeedSource.seed` is non-view by design, so
///      it is a real CALL sitting inside the mint choke point.
contract ReentrantSeedSource is IAbxSeedSource {
    address public token;
    bool public editionLane;
    uint256 public depth;
    uint256 public maxDepth;

    function arm(address token_, bool editionLane_, uint256 maxDepth_) external {
        token = token_;
        editionLane = editionLane_;
        maxDepth = maxDepth_;
    }

    function seed(uint256 id, address) external returns (bytes32) {
        if (depth < maxDepth) {
            ++depth;
            if (editionLane) IEdMint(token).mint(address(this), id, 1);
            else ISeqMint(token).mint(address(this));
        }
        return keccak256(abi.encode(id, depth));
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }
}

interface IEdMint {
    function mint(address to, uint256 id, uint256 amount) external;
}

interface ISeqMint {
    function mint(address to) external returns (uint256);
}

/// @dev Grinds candidate recipients looking for distinct seeds — the attack that worked when `to`
///      was part of the preimage.
contract Grinder {
    function seedsFor(IAbxSeedSource source, uint256 tokenId, uint256 n)
        external
        returns (bytes32[] memory out)
    {
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = source.seed(tokenId, address(uint160(uint256(keccak256(abi.encode(i))))));
        }
    }
}

/// @dev Passes the misconfiguration probe (an unknown selector reverts) but refuses every real
///      transfer — the shape that freezes a collection.
contract PermissiveButRevertingOnTransfer {
    function validateTransfer(address, address, address, uint256) external pure {
        revert("policy: no");
    }
}

/// Security invariants pinned against their exploit conditions.
contract SeedAndCapInvariantsTest is Test {
    SeriesCodeFactory seriesFactory;
    EditionCodeFactory editionFactory;
    address owner = address(0xA11CE);
    address collector = address(0xB0B);

    function setUp() public {
        seriesFactory = new SeriesCodeFactory();
        editionFactory = new EditionCodeFactory();
    }

    function _series(address seedSource, uint256 max) internal returns (SeriesCode) {
        SeriesCode.InitParams memory p;
        p.owner = owner;
        p.name = "S";
        p.symbol = "S";
        p.maxInvocations = max;
        p.seedSource = seedSource;
        p.royaltyReceiver = owner;
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        return SeriesCode(seriesFactory.deploy(p));
    }

    function _edition(address seedSource, uint256 editionSize) internal returns (EditionCode) {
        EditionCode.InitParams memory p;
        p.owner = owner;
        p.name = "E";
        p.symbol = "E";
        p.maxInvocations = 100;
        p.editionSize = editionSize;
        p.seedSource = seedSource;
        p.royaltyReceiver = owner;
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        return EditionCode(editionFactory.deploy(p));
    }

    // ── the per-id edition cap now binds under reentrancy ────────────────────--

    function test_ReentrantSeedSourceCannotExceedEditionCap() public {
        ReentrantSeedSource src = new ReentrantSeedSource();
        EditionCode nft = _edition(address(src), 10);
        vm.prank(owner);
        nft.setMinter(address(src)); // the hostile source also holds mint rights
        src.arm(address(nft), true, 50);

        vm.prank(address(src));
        (bool ok,) = address(nft).call(
            abi.encodeWithSignature("mint(address,uint256,uint256)", collector, uint256(0), uint256(1))
        );

        // Whether the nested mint reverts the batch or unwinds, the cap must hold.
        assertLe(nft.totalSupply(0), nft.maxSupply(0), "per-id supply must never exceed the cap");
        if (ok) assertLe(nft.totalSupply(0), 10, "cap is 10");
    }

    // ── the series cursor is committed before any external call ──────────────--

    function test_ReentrantSeedSourceCannotExceedSeriesCap() public {
        ReentrantSeedSource src = new ReentrantSeedSource();
        SeriesCode nft = _series(address(src), 5);
        vm.prank(owner);
        nft.setMinter(address(src));
        src.arm(address(nft), false, 50);

        vm.prank(address(src));
        address(nft).call(abi.encodeWithSignature("mint(address)", collector));

        assertLe(nft.totalSupply(), nft.maxInvocations(), "supply must never exceed the cap");
        assertLe(nft.nextTokenId(), nft.maxInvocations(), "cursor must never pass the cap");
    }

    /// The cursor is reserved before the seed call, so nested mints get distinct ids rather than
    /// colliding on one — the previous behaviour depended on Solady's duplicate-id revert.
    function test_NestedMintsGetDistinctIdsNotACollision() public {
        ReentrantSeedSource src = new ReentrantSeedSource();
        SeriesCode nft = _series(address(src), 10);
        vm.prank(owner);
        nft.setMinter(address(src));
        src.arm(address(nft), false, 2);

        vm.prank(address(src));
        (bool ok,) = address(nft).call(abi.encodeWithSignature("mint(address)", collector));
        if (ok) {
            // three mints total (outer + two nested), all distinct, all within the cap
            assertEq(nft.totalSupply(), 3);
            assertEq(nft.nextTokenId(), 3);
        }
        assertLe(nft.nextTokenId(), 10);
    }

    // ── a settled seed is final, by every route ──────────────────────────────--

    function test_SeedIsTerminal_RawSetterRefused() public {
        SeriesCode nft = _series(address(new AbxSeedSource()), 10);
        vm.prank(owner);
        nft.mint(collector);
        (, , bool isSet) = nft.tokenParam(0, "seed");
        assertTrue(isSet);

        vm.prank(owner);
        (bool ok,) = address(nft).call(
            abi.encodeWithSignature(
                "setTokenParam(uint256,bytes32,bytes32)", uint256(0), bytes32("seed"), bytes32("x")
            )
        );
        assertFalse(ok, "raw setter must not rewrite a settled seed");
    }

    function test_SeedIsTerminal_CannotBeCleared() public {
        SeriesCode nft = _series(address(new AbxSeedSource()), 10);
        vm.prank(owner);
        nft.mint(collector);

        vm.prank(owner);
        (bool ok,) = address(nft).call(
            abi.encodeWithSignature("clearTokenParam(uint256,bytes32)", uint256(0), bytes32("seed"))
        );
        assertFalse(ok, "a settled seed must not be clearable");
    }

    /// @dev The seed's governance model is a pre-sale commitment. Re-rollable seeds remain a
    ///      supported feature — the creator declares a `seed` schema and (typically) authorizes the
    ///      TokenOwner — but the declaration has to happen before any seed exists, so a buyer can
    ///      read `paramSchema("seed")` and know what they are buying. These two tests pin both
    ///      halves of that rule.
    function _declareSeedSchema(SeriesCode nft, IAbxConfigurableParams.AuthOption auth)
        internal
        returns (bool ok)
    {
        vm.prank(owner);
        (ok,) = address(nft).call(
            abi.encodeWithSignature(
                "setParamSchema(bytes32,uint8,uint8,address,uint48,bytes32,bytes32,string[])",
                bytes32("seed"),
                uint8(IAbxConfigurableParams.ParamType.Uint256Range),
                uint8(auth),
                address(0),
                uint48(0),
                bytes32(0),
                bytes32(0),
                new string[](0)
            )
        );
    }

    /// Declaring a `seed` schema after the sale must not re-open the governed write path and let the
    /// creator reassign a sold token's work.
    function test_SeedSchemaCannotBeDeclaredAfterTheFirstSeedExists() public {
        SeriesCode nft = _series(address(new AbxSeedSource()), 10);
        vm.prank(owner);
        nft.mint(collector);
        (bytes32 before,,) = nft.tokenParam(0, "seed");

        assertFalse(
            _declareSeedSchema(nft, IAbxConfigurableParams.AuthOption.Creator),
            "a seed schema must not be declarable once a seed exists"
        );

        (bytes32 afterVal,,) = nft.tokenParam(0, "seed");
        assertEq(afterVal, before, "the collector's seed is unchanged");
    }

    /// The feature itself still works when the project commits to it up front.
    function test_SeedSchemaDeclaredBeforeAnyMintStillEnablesReassignment() public {
        SeriesCode nft = _series(address(new AbxSeedSource()), 10);
        assertTrue(
            _declareSeedSchema(nft, IAbxConfigurableParams.AuthOption.TokenOwner),
            "declaring the seed schema pre-mint must succeed"
        );

        vm.prank(owner);
        nft.mint(collector);
        (bytes32 minted,,) = nft.tokenParam(0, "seed");

        vm.prank(collector); // the schema authorizes the token owner to choose their seed
        nft.configureTokenParam(0, "seed", bytes32(uint256(42)));

        (bytes32 chosen,,) = nft.tokenParam(0, "seed");
        assertEq(chosen, bytes32(uint256(42)), "the disclosed reassignment feature still works");
        assertTrue(chosen != minted);
    }

    function test_SeedIsNeverDataBacked() public {
        SeriesCode nft = _series(address(0), 10); // no source: seed unset, so this is a fresh write
        vm.prank(owner);
        (bool ok,) = address(nft).call(
            abi.encodeWithSignature(
                "setTokenParamData(uint256,bytes32,bytes)", uint256(0), bytes32("seed"), bytes("xy")
            )
        );
        assertFalse(ok, "seed must never be stored as a data blob");
    }

    // ── the canonical source no longer keys on the buyer's chosen recipient ──--

    function test_CanonicalSeedIgnoresRecipient() public {
        AbxSeedSource s = new AbxSeedSource();
        bytes32 a = s.seed(7, address(0xAAA1));
        bytes32 b = s.seed(7, address(0xBBB2));
        assertEq(a, b, "`to` must not enter the preimage");
    }

    /// The grind that used to select a rare outcome deterministically now returns one value.
    function test_GrindingRecipientsYieldsNoChoice() public {
        AbxSeedSource s = new AbxSeedSource();
        Grinder g = new Grinder();
        bytes32[] memory seeds = g.seedsFor(s, 0, 64);
        for (uint256 i = 1; i < seeds.length; ++i) {
            assertEq(seeds[i], seeds[0], "64 candidate recipients must all yield the same seed");
        }
    }

    /// Domain separation and per-id variation still hold — this is what the source is for.
    function test_SeedStillVariesByTokenAndId() public {
        AbxSeedSource s = new AbxSeedSource();
        vm.prank(address(0xCAFE));
        bytes32 fromA = s.seed(1, address(0));
        vm.prank(address(0xF00D));
        bytes32 fromB = s.seed(1, address(0));
        assertTrue(fromA != fromB, "different calling tokens must differ");
        assertTrue(s.seed(1, address(0)) != s.seed(2, address(0)), "different ids must differ");
    }

    // ── the dead-man release on an abandoned creator token ───────────────────--

    /// A reverting validator on an ownerless collection used to freeze every collector's token
    /// forever, unrecoverable by anyone. Now any holder can suspend enforcement — and only suspend.
    function test_OwnerlessCollectionCanBeSuspendedByAnyone() public {
        SeriesCode nft = _series(address(0), 10);
        vm.prank(owner);
        nft.mint(collector);

        // enrolled at deploy is required for a validator to exist at all, so use a fresh one
        SeriesCode.InitParams memory p;
        p.owner = owner;
        p.name = "S";
        p.symbol = "S";
        p.maxInvocations = 10;
        p.royaltyReceiver = owner;
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        p.transferValidator = address(new PermissiveButRevertingOnTransfer());
        p.mintTo = collector;
        p.mintCount = 1;
        SeriesCode enrolled = SeriesCode(seriesFactory.deploy(p));

        vm.prank(owner);
        enrolled.renounceOwnership();
        assertEq(enrolled.owner(), address(0));

        // transfers are blocked and there is no owner left to re-point the validator
        vm.prank(collector);
        (bool moved,) = address(enrolled).call(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)", collector, address(0xDEAD1), uint256(0)
            )
        );
        assertFalse(moved, "validator is blocking");

        // any stranger may suspend enforcement on an abandoned collection
        vm.prank(address(0xBEEF));
        enrolled.setTransferValidator(address(0));
        assertEq(enrolled.getTransferValidator(), address(0));

        vm.prank(collector);
        enrolled.transferFrom(collector, address(0xDEAD1), 0);
        assertEq(enrolled.ownerOf(0), address(0xDEAD1), "collector's property is recovered");
    }

    /// The permission is asymmetric: an ownerless collection can never be re-armed.
    function test_OwnerlessCollectionCannotBeReArmed() public {
        SeriesCode.InitParams memory p;
        p.owner = owner;
        p.name = "S";
        p.symbol = "S";
        p.maxInvocations = 10;
        p.royaltyReceiver = owner;
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        p.transferValidator = address(new PermissiveButRevertingOnTransfer());
        SeriesCode enrolled = SeriesCode(seriesFactory.deploy(p));
        vm.prank(owner);
        enrolled.renounceOwnership();

        vm.prank(address(0xBEEF));
        (bool ok,) = address(enrolled).call(
            abi.encodeWithSignature("setTransferValidator(address)", address(0xABCD))
        );
        assertFalse(ok, "a stranger must not be able to arm a validator");
    }

    /// While an owner exists, a stranger has no say at all.
    function test_OwnedCollectionRejectsStrangerSuspend() public {
        SeriesCode.InitParams memory p;
        p.owner = owner;
        p.name = "S";
        p.symbol = "S";
        p.maxInvocations = 10;
        p.royaltyReceiver = owner;
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        p.transferValidator = address(new PermissiveButRevertingOnTransfer());
        SeriesCode enrolled = SeriesCode(seriesFactory.deploy(p));

        vm.prank(address(0xBEEF));
        (bool ok,) = address(enrolled).call(
            abi.encodeWithSignature("setTransferValidator(address)", address(0))
        );
        assertFalse(ok, "only the owner may touch a live project's validator");
    }

    /// A collection cannot be born ownerless — the one-transaction "already holds tokens, already
    /// enforcing, nobody can ever suspend it" state is unreachable.
    function test_CannotInitializeWithZeroOwner() public {
        SeriesCode.InitParams memory p;
        p.owner = address(0);
        p.name = "S";
        p.symbol = "S";
        p.maxInvocations = 10;
        p.royaltyReceiver = address(0xA11CE);
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        vm.expectRevert();
        seriesFactory.deploy(p);
    }
}
