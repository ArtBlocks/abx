// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {EditionImage} from "../src/tokens/EditionImage.sol";
import {EditionImageFactory} from "../src/factories/EditionImageFactory.sol";
import {MaxInvocations} from "../src/extensions/max-invocations/MaxInvocations.sol";
import {EditionSupply} from "../src/extensions/edition-supply/EditionSupply.sol";
import {IAbxEditionMint} from "../src/interfaces/IAbxEditionMint.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice Core behavior of a deployed multi-work edition clone: the id-space cap
///         (`MaxInvocations`, reused as-is), caller-named (non-sequential) ids, the id
///         high-water-mark floor, per-id supply caps, batch-transfer supply accounting, and the
///         `uri()` base/renderer swap's config-event-only signal + the permissionless chunked
///         `pingURI` re-emission helper. Mirrors {SeriesImageTest}'s scope, generalized to
///         copies-per-work.
contract EditionImageTest is Test {
    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 amount
    );
    event TransferBatch(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256[] ids,
        uint256[] amounts
    );
    event URI(string value, uint256 indexed id);
    event TokenURIBaseSet(string base);
    event TokenURIRendererSet(address indexed renderer);

    EditionImageFactory internal factory;
    EditionImage internal nft;

    address internal owner = makeAddr("owner");
    address internal minter = makeAddr("minter");
    address internal collector = makeAddr("collector");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant N = 5; // id-space cap

    function setUp() public {
        factory = new EditionImageFactory();
        nft = EditionImage(factory.deploy(_params()));
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
            royaltyReceiver: owner,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            maxInvocations: N,
            editionSize: 0,
            primaryPayee: address(0),
            minter: minter,
            paused: false,
            mintTo: address(0),
            mintCount: 0,
            mintAmount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    // ---- initial state + deploy-time mint ----

    function test_InitialState() public view {
        assertEq(nft.owner(), owner);
        assertEq(nft.maxInvocations(), N);
        assertTrue(nft.supportsInterface(type(IAbxEditionMint).interfaceId));
        assertTrue(nft.supportsInterface(0xd9b67a26));
    }

    function test_DeployTime_MintsMultipleIdsWithAmounts() public {
        EditionImage.InitParams memory p = _params();
        p.mintTo = owner;
        p.mintCount = 3;
        p.mintAmount = 4;
        EditionImage n = EditionImage(factory.deploy(p));
        assertEq(n.balanceOf(owner, 0), 4);
        assertEq(n.balanceOf(owner, 1), 4);
        assertEq(n.balanceOf(owner, 2), 4);
        assertEq(n.totalSupply(0), 4);
        assertEq(n.totalSupply(3), 0);
    }

    // ---- minting: caller-named, non-sequential ids ----

    function test_Mint_NonSequentialIdsAllowed() public {
        vm.prank(owner);
        nft.mint(collector, 4, 2); // the LAST valid id, minted first — no id 0..3 required
        assertEq(nft.balanceOf(collector, 4), 2);
        assertEq(nft.totalSupply(4), 2);
        assertEq(nft.totalSupply(0), 0);
    }

    function test_Mint_RevertsExceedsIdSpace() public {
        vm.prank(owner);
        vm.expectRevert(MaxInvocations.MaxInvocationsReached.selector);
        nft.mint(collector, 5, 1); // id == maxInvocations, out of range
    }

    function test_Mint_RevertsZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(EditionImage.ZeroMintAmount.selector);
        nft.mint(collector, 0, 0);
    }

    function test_Mint_MinterMayWhenUnpaused() public {
        vm.prank(minter);
        nft.mint(collector, 2, 1);
        assertEq(nft.balanceOf(collector, 2), 1);
    }

    function test_Mint_RevertsWhenPausedForMinter() public {
        vm.prank(owner);
        nft.setPaused(true);
        vm.prank(minter);
        vm.expectRevert(EditionImage.MintingPaused.selector);
        nft.mint(collector, 0, 1);
    }

    // ---- the id high-water mark: MaxInvocations' floor, generalized ----

    function test_SetMaxInvocations_RevertsBelowWatermark() public {
        vm.prank(owner);
        nft.mint(collector, 3, 1); // watermark advances to 4
        vm.prank(owner);
        vm.expectRevert(MaxInvocations.MaxInvocationsBelowFloor.selector);
        nft.setMaxInvocations(3); // would strand id 3
    }

    function test_SetMaxInvocations_AllowsLoweringAboveWatermark() public {
        vm.prank(owner);
        nft.mint(collector, 1, 1); // watermark advances to 2
        vm.prank(owner);
        nft.setMaxInvocations(3); // still covers ids 0..2
        assertEq(nft.maxInvocations(), 3);
    }

    // ---- Edition Supply (per-id copy cap), orthogonal to the id-space cap ----

    function test_EditionSupply_PerIdCapIndependentOfOthers() public {
        vm.prank(owner);
        nft.setMaxSupply(0, 2);
        vm.prank(owner);
        nft.mint(collector, 0, 2);
        vm.prank(owner);
        vm.expectRevert(EditionSupply.EditionSupplyReached.selector);
        nft.mint(collector, 0, 1);
        // id 1 is unaffected by id 0's cap
        vm.prank(owner);
        nft.mint(collector, 1, 100);
        assertEq(nft.totalSupply(1), 100);
    }

    // ---- batch transfer supply accounting ----

    function test_BatchTransfer_SupplyUnaffected_BurnDecrements() public {
        vm.prank(owner);
        nft.mint(collector, 0, 5);
        vm.prank(owner);
        nft.mint(collector, 1, 7);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 5;
        amounts[1] = 7;

        vm.prank(collector);
        nft.safeBatchTransferFrom(collector, stranger, ids, amounts, "");
        assertEq(nft.totalSupply(0), 5); // holder-to-holder: unchanged
        assertEq(nft.totalSupply(1), 7);
        assertEq(nft.balanceOf(stranger, 0), 5);
        assertEq(nft.balanceOf(stranger, 1), 7);
    }

    // ---- uri() base/renderer swap: config event only, no automatic URI loop (Fix 2) ----

    function test_SetTokenURIBase_EmitsNoUriEvents_OnlyConfigEvent() public {
        vm.recordLogs();
        vm.prank(owner);
        nft.setTokenURIBase("https://abx.test/t2");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 uriPings;
        uint256 configEvents;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("URI(string,uint256)")) ++uriPings;
            if (logs[i].topics[0] == keccak256("TokenURIBaseSet(string)")) ++configEvents;
        }
        assertEq(uriPings, 0); // no unbounded loop — an owner op that could never succeed on a
        // large id space must not be attempted automatically
        assertEq(configEvents, 1); // the contract-wide re-point signal fires exactly once
    }

    function test_SetTokenURIRenderer_EmitsNoUriEvents_OnlyConfigEvent() public {
        vm.recordLogs();
        vm.prank(owner);
        nft.setTokenURIRenderer(address(0xBEEF));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 uriPings;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("URI(string,uint256)")) ++uriPings;
        }
        assertEq(uriPings, 0);
        assertEq(nft.tokenURIRenderer(), address(0xBEEF));
    }

    // ---- pingURI: the OWNER's chunked, caller-named re-emission ----

    function test_PingURI_EmitsExactlyRequestedIdsWithCurrentValues() public {
        uint256[] memory ids = new uint256[](3);
        ids[0] = 0;
        ids[1] = 2;
        ids[2] = 4;

        for (uint256 i; i < ids.length; ++i) {
            vm.expectEmit(true, false, false, true);
            emit URI(nft.uri(ids[i]), ids[i]);
        }
        vm.prank(owner);
        nft.pingURI(ids);
    }

    /// It used to be permissionless. With an on-chain renderer that is asymmetric — the caller pays
    /// event gas while an event-driven indexer may perform an expensive `uri(id)` per id, for ids it
    /// chose. Owner-only matches what the verb is for: an owner's follow-up to a re-point.
    function test_PingURI_IsOwnerOnly() public {
        uint256[] memory ids = new uint256[](1);
        vm.prank(stranger);
        vm.expectRevert();
        nft.pingURI(ids);
    }

    function test_PingURI_ReflectsBaseSwapWhenCalledAfter() public {
        vm.prank(owner);
        nft.setTokenURIBase("https://abx.test/t2"); // no automatic URI emission (see above)

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.expectEmit(true, false, false, true);
        emit URI(nft.uri(1), 1);
        vm.prank(owner);
        nft.pingURI(ids); // the owner's explicit, chunked re-emission after the re-point
    }

    // ---- setTokenURIOverride still auto-pings a single id, O(1) (unchanged by Fix 2) ----

    function test_SetTokenURIOverride_StillAutoPingsUri() public {
        vm.expectEmit(true, false, false, true);
        emit URI("ipfs://override-0", 0);
        vm.prank(owner);
        nft.setTokenURIOverride(0, "ipfs://override-0");
        assertEq(nft.uri(0), "ipfs://override-0");
    }
}
