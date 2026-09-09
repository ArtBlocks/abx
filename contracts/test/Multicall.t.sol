// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {TokenURI} from "../src/uri/token/TokenURI.sol";
import {AbxChunkStore} from "../src/renderers/AbxChunkStore.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice The native batching layer ({Multicallable}) and its security invariants.
///         A `multicall` must be EXACTLY equivalent to sending each call individually
///         from the same sender — no authority amplification, atomic all-or-nothing,
///         and no `msg.value` double-spend surface. Also exercises the chunk store's
///         atomic `writeContent` and batched chunk writes.
contract MulticallTest is Test {
    bytes32 internal constant NAME = "name";
    bytes32 internal constant DESCRIPTION = "description";
    bytes32 internal constant IMAGE = "image";
    bytes32 internal constant INLINE = "inline";

    OneOfOneImageFactory internal factory;
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal renderer = makeAddr("renderer");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");

    function setUp() public {
        factory = new OneOfOneImageFactory();
    }

    function _deploy() internal returns (OneOfOneImage token) {
        OneOfOneImage.InitParams memory p = OneOfOneImage.InitParams({
            owner: owner,
            mintTo: owner,
            name: "Batch",
            symbol: "BAT",
            tokenURIBase: "ipfs://off-chain",
            tokenURIRenderer: address(0),
            contractURIBase: "ipfs://off-chain-contract",
            contractURIRenderer: address(0),
            royaltyReceiver: royaltyReceiver,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
        token = OneOfOneImage(factory.deploy(p));
    }

    // ── token: a batch applies every owner op atomically ───────────────────────

    function test_OwnerBatch_AppliesAllOps() public {
        OneOfOneImage token = _deploy();

        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(
            OnChainMetadata.setTokenField, (0, NAME, INLINE, bytes("On-Chain Name"))
        );
        calls[1] = abi.encodeCall(
            OnChainMetadata.setTokenField, (0, DESCRIPTION, INLINE, bytes("A batched description"))
        );
        calls[2] = abi.encodeCall(TokenURI.setTokenURIRenderer, (renderer));

        vm.prank(owner);
        token.multicall(calls);

        (bytes32 rep, bytes memory val) = token.tokenField(0, NAME);
        assertEq(rep, INLINE);
        assertEq(val, bytes("On-Chain Name"));
        (, bytes memory desc) = token.tokenField(0, DESCRIPTION);
        assertEq(desc, bytes("A batched description"));
        assertEq(token.tokenURIRenderer(), renderer);
    }

    // ── invariant: multicall grants NO authority — non-owner batch reverts ──────

    function test_NonOwnerBatch_Reverts() public {
        OneOfOneImage token = _deploy();

        bytes[] memory calls = new bytes[](1);
        calls[0] =
            abi.encodeCall(OnChainMetadata.setTokenField, (0, NAME, INLINE, bytes("spoofed")));

        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        token.multicall(calls);

        // nothing applied
        (bytes32 rep,) = token.tokenField(0, NAME);
        assertEq(rep, bytes32(0));
    }

    // ── invariant: a lock inside a batch reverts the WHOLE batch (atomic) ───────

    function test_LockedFieldInBatch_RevertsWholeBatch() public {
        OneOfOneImage token = _deploy();

        // lock the name field first
        vm.prank(owner);
        token.lockTokenField(0, NAME);

        // a batch that sets a fresh field AND tries to write the locked one
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            OnChainMetadata.setTokenField, (0, DESCRIPTION, INLINE, bytes("should not persist"))
        );
        calls[1] =
            abi.encodeCall(OnChainMetadata.setTokenField, (0, NAME, INLINE, bytes("locked out")));

        vm.prank(owner);
        vm.expectRevert(OnChainMetadata.FieldLocked.selector);
        token.multicall(calls);

        // the whole batch reverted — the description from calls[0] did NOT persist
        (bytes32 rep,) = token.tokenField(0, DESCRIPTION);
        assertEq(rep, bytes32(0), "atomicity violated: a sibling op persisted");
    }

    // ── invariant: no msg.value double-spend surface — value reverts ────────────

    function test_MulticallWithValue_Reverts() public {
        OneOfOneImage token = _deploy();
        vm.deal(owner, 1 ether);

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(OnChainMetadata.setTokenField, (0, NAME, INLINE, bytes("paid?")));

        vm.prank(owner);
        vm.expectRevert(); // Solady Multicallable reverts on non-zero msg.value
        token.multicall{value: 1}(calls);
    }

    // ── chunk store: atomic writeContent in one call ────────────────────────────

    function test_ChunkStore_WriteContent_OneCall() public {
        AbxChunkStore store = new AbxChunkStore();

        bytes[] memory datas = new bytes[](2);
        datas[0] = bytes("first-half|");
        datas[1] = bytes("second-half");
        bool[] memory compressed = new bool[](2);

        address manifest = store.writeContent(datas, compressed);
        assertEq(store.read(manifest), bytes.concat(datas[0], datas[1]));
    }

    function test_ChunkStore_WriteContent_LengthMismatchReverts() public {
        AbxChunkStore store = new AbxChunkStore();
        bytes[] memory datas = new bytes[](2);
        bool[] memory compressed = new bool[](1);
        vm.expectRevert(AbxChunkStore.LengthMismatch.selector);
        store.writeContent(datas, compressed);
    }

    // ── chunk store: batched chunk writes via multicall, addresses come back ────

    function test_ChunkStore_BatchedWriteChunk_ReturnsAddresses() public {
        AbxChunkStore store = new AbxChunkStore();

        bytes memory a = bytes("alpha");
        bytes memory b = bytes("beta");
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(AbxChunkStore.writeChunk, (a));
        calls[1] = abi.encodeCall(AbxChunkStore.writeChunk, (b));

        bytes[] memory results = store.multicall(calls);
        address pa = abi.decode(results[0], (address));
        address pb = abi.decode(results[1], (address));

        // assemble the manifest from the real returned addresses, then read back
        AbxChunkStore.Chunk[] memory chunks = new AbxChunkStore.Chunk[](2);
        chunks[0] = AbxChunkStore.Chunk({pointer: pa, compressed: false});
        chunks[1] = AbxChunkStore.Chunk({pointer: pb, compressed: false});
        address manifest = store.writeManifest(chunks);
        assertEq(store.read(manifest), bytes.concat(a, b));
    }
}
