// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Base64} from "solady/utils/Base64.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {SeriesImage} from "../src/tokens/SeriesImage.sol";
import {SeriesImageFactory} from "../src/factories/SeriesImageFactory.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {MaxInvocations} from "../src/extensions/max-invocations/MaxInvocations.sol";
import {TokenDataLib} from "../src/libraries/TokenDataLib.sol";
import {IAbxAugmentHook} from "../src/extensions/configurable-params/IAbxParamHooks.sol";
import {IAbxConfigurableParams} from
    "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {AbxParamsLib} from "../src/libraries/AbxParamsLib.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Returns a large blob of raw returndata while staying cheap in its own frame. This is the
///      shape that used to make a collector's `transferFrom` run out of gas: the CALLER pays to
///      copy returndata, and discarding the bytes does not skip the copy.
contract ReturnBombTransferHook {
    function onTokenTransfer(uint256, address, address, address, uint256) external pure {
        assembly {
            return(0, 200000)
        }
    }
}

/// @dev Refuses every transfer — the veto in its worst configuration.
contract RevertingTransferHook {
    function onTokenTransfer(uint256, address, address, address, uint256) external pure {
        revert("no transfers");
    }
}

/// @dev Records what it was told, so the hand-written assembly call's argument encoding is
///      provable. A mis-encoded calldata window would be invisible from outside: the result is
///      discarded by design, so the only symptom would be a hook that never works.
contract RecordingTransferHook {
    uint256 public lastId;
    address public lastFrom;
    address public lastTo;
    uint256 public calls;

    function onTokenTransfer(uint256 tokenId, address from, address to, address, uint256) external {
        lastId = tokenId;
        lastFrom = from;
        lastTo = to;
        ++calls;
    }
}

contract RevertingTransferHookLocal {
    function onTokenTransfer(uint256, address, address, address, uint256) external pure {
        revert("policy: no");
    }
}

/// @dev Burns every unit of gas it is handed, then returns NORMALLY — it never reverts.

contract GasBurningTransferHook {
    function onTokenTransfer(uint256, address, address, address, uint256) external view {
        uint256 x = 1;
        while (gasleft() > 200) {
            x = uint256(keccak256(abi.encode(x)));
        }
    }
}

/// @dev Tries to forge the reserved tokenData coordinates the work trusts as ground truth.
contract CoordinateForgingAugmentHook is IAbxAugmentHook {
    function augmentTokenParams(address, uint256)
        external
        pure
        returns (AugmentedParam[] memory out)
    {
        out = new AugmentedParam[](5);
        out[0] = AugmentedParam({key: "seed", value: "forged-seed"});
        out[1] = AugmentedParam({key: "tokenId", value: "999"});
        out[2] = AugmentedParam({key: "chainId", value: "1"});
        out[3] = AugmentedParam({key: "contractAddress", value: "0xdeadbeef"});
        out[4] = AugmentedParam({key: 'ok","x":"y', value: "legit"}); // and a JSON-breaking key
    }
}

/// @dev Exercises TokenDataLib's internal composition the way a field renderer does.
contract TokenDataHarness {
    function build(address token, uint256 id) external view returns (string memory) {
        return TokenDataLib.finish(
            TokenDataLib.augmentedEntries(TokenDataLib.begin(token, id), token, id)
        );
    }
}

contract SecurityPropertiesTest is Test {
    SeriesCodeFactory seriesCodeFactory;
    OneOfOneImageFactory oneOfOneFactory;
    SeriesImageFactory seriesImageFactory;
    AbxMetadataRenderer renderer;

    address owner = address(0xA11CE);
    address collector = address(0xB0B);
    address buyer2 = address(0xCAFE);

    function setUp() public {
        seriesCodeFactory = new SeriesCodeFactory();
        oneOfOneFactory = new OneOfOneImageFactory();
        seriesImageFactory = new SeriesImageFactory();
        renderer = new AbxMetadataRenderer();
    }

    function _seriesCode() internal returns (SeriesCode n) {
        SeriesCode.InitParams memory p;
        p.owner = owner;
        p.name = "S";
        p.symbol = "S";
        p.maxInvocations = 10;
        p.royaltyReceiver = owner;
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        p.mintTo = collector;
        p.mintCount = 1;
        n = SeriesCode(seriesCodeFactory.deploy(p));
    }

    function _oneOfOne(IAbxOnChainMetadata.FieldInput[] memory f) internal returns (OneOfOneImage) {
        IAbxOnChainMetadata.FieldInput[] memory none = new IAbxOnChainMetadata.FieldInput[](0);
        return OneOfOneImage(
            oneOfOneFactory.deploy(
                OneOfOneImage.InitParams({
                    owner: owner,
                    mintTo: collector,
                    name: "N",
                    symbol: "S",
                    tokenURIBase: "",
                    tokenURIRenderer: address(renderer),
                    contractURIBase: "",
                    contractURIRenderer: address(renderer),
                    royaltyReceiver: owner,
                    royaltyBps: 500,
                    maxRoyaltyBps: 1000,
                    burnable: false,
                    transferValidator: address(0),
                    tokenFields: f,
                    contractFields: none
                })
            )
        );
    }

    // ── the transfer hook can no longer block or inflate a collector's transfer ──

    function test_ReturnBombTransferHookDoesNotBlockTransfer() public {
        SeriesCode nft = _seriesCode();
        address hook = address(new ReturnBombTransferHook());
        vm.prank(owner);
        nft.setParamHooks(address(0), address(0), hook);

        uint256[5] memory limits =
            [uint256(150_000), 400_000, 1_000_000, 5_000_000, 30_000_000];
        for (uint256 i; i < limits.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.prank(collector);
            (bool ok,) = address(nft).call{gas: limits[i]}(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256)", collector, buyer2, uint256(0)
                )
            );
            assertTrue(ok, "a return-bombing hook must never block a transfer");
            vm.revertToState(snap);
        }
    }

    /// @dev A transfer hook is a VETO: its revert bubbles and the transfer fails. That is the whole
    ///      disclosure, and it replaced a "never blocks a transfer" promise that could not be kept —
    ///      Solady runs the receiver acceptance check AFTER the hook, so on `safeTransferFrom` a hook
    ///      armed between gas estimation and execution starved it regardless of any cap we applied.
    ///      Withdrawing the promise and adding `lockParamHooks()` (a project can prove it will never
    ///      arm one) is honest where capping and swallowing was not.
    ///
    ///      Only the reverting hook is asserted here. A hook that merely burns gas and returns
    ///      normally may or may not block a plain `transferFrom` depending on whether it has enough
    ///      left to return — a knife-edge that is not worth pinning in a test, and immaterial now
    ///      that blocking is permitted behaviour rather than a violated invariant.
    function test_RevertingHookVetoesTheTransfer() public {
        SeriesCode nft = _seriesCode();
        address hook = address(new RevertingTransferHookLocal());
        vm.prank(owner);
        nft.setParamHooks(address(0), address(0), hook);

        vm.prank(collector);
        vm.expectRevert();
        nft.transferFrom(collector, buyer2, 0);
        assertEq(nft.ownerOf(0), collector, "the veto held the token in place");
    }

    /// @dev The mitigation: a project can freeze its hook set, so a buyer can verify that no veto
    ///      will ever be armed against them.
    function test_LockedHooksCannotBeArmedLater() public {
        SeriesCode nft = _seriesCode();
        vm.prank(owner);
        nft.lockParamHooks();

        address hook = address(new RevertingTransferHookLocal());
        vm.prank(owner);
        (bool ok,) = address(nft).call(
            abi.encodeWithSignature(
                "setParamHooks(address,address,address)", address(0), address(0), hook
            )
        );
        assertFalse(ok, "a frozen hook set refuses a later veto");

        vm.prank(collector);
        nft.transferFrom(collector, buyer2, 0);
        assertEq(nft.ownerOf(0), buyer2, "and the collector can still sell");
    }

    /// @dev The cap must be generous enough that an HONEST hook actually runs. At 100_000 it was
    ///      not: a hook writing five fresh storage slots costs ~100k+, so it OOG'd inside its own
    ///      frame and — because the revert is swallowed by design — silently did nothing while
    ///      appearing wired. A silently-inert hook is a worse failure than bounded griefing.
    function test_HonestTransferHookHasRoomToWork() public {
        SeriesCode nft = _seriesCode();
        RecordingTransferHook hook = new RecordingTransferHook();
        vm.prank(owner);
        nft.setParamHooks(address(0), address(0), address(hook));

        vm.prank(collector);
        nft.transferFrom(collector, buyer2, 0);

        assertEq(hook.calls(), 1, "the hook actually ran");
        assertEq(hook.lastId(), 0, "tokenId encoded correctly by the assembly call");
        assertEq(hook.lastFrom(), collector, "from encoded correctly");
        assertEq(hook.lastTo(), buyer2, "to encoded correctly");
    }

    // ── the provenance block can no longer be forged ─────────────────────────--

    function test_HostileRepresentationCannotForgeProvenance() public {
        // 32 bytes of attacker-chosen `representation`, shaped to close the JSON string and write
        // new structure: unescaped this flipped `onChain` to true while staying valid JSON.
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = IAbxOnChainMetadata.FieldInput({
            field: "description",
            representation: bytes32('x","forged":"'),
            value: bytes("v")
        });
        OneOfOneImage nft = _oneOfOne(f);

        string memory uri = _decodeJson(nft.tokenURI(0));
        assertFalse(
            LibString.contains(uri, '","forged"'),
            "the injected structure must not appear as JSON structure"
        );
        assertTrue(LibString.contains(uri, "\\\""), "the quote is escaped instead");
    }

    /// @dev Strip the `data:application/json;base64,` prefix and decode, so assertions run against
    ///      the JSON a consumer actually parses rather than its base64 envelope.
    function _decodeJson(string memory uri) internal pure returns (string memory) {
        uint256 comma;
        bytes memory b = bytes(uri);
        while (comma < b.length && b[comma] != ",") ++comma;
        return string(Base64.decode(LibString.slice(uri, comma + 1)));
    }

    // ── an augment hook cannot forge the reserved coordinates ────────────────--

    function test_AugmentHookCannotForgeReservedCoordinates() public {
        SeriesCode nft = _seriesCode();
        address hook = address(new CoordinateForgingAugmentHook());
        TokenDataHarness harness = new TokenDataHarness();
        vm.prank(owner);
        nft.setParamHooks(address(0), hook, address(0));

        string memory data = harness.build(address(nft), 0);

        assertFalse(LibString.contains(data, "forged-seed"), "seed must not be forgeable");
        assertFalse(LibString.contains(data, '"tokenId":"999"'), "tokenId must not be forgeable");
        assertFalse(LibString.contains(data, '"chainId":"1"'), "chainId must not be forgeable");
        assertFalse(
            LibString.contains(data, "0xdeadbeef"), "contractAddress must not be forgeable"
        );
        // a non-reserved key still rides, but its JSON-breaking bytes are escaped
        assertTrue(LibString.contains(data, "legit"), "legitimate augment entries still ride");
        assertFalse(
            LibString.contains(data, 'ok","x":"y"'), "an augment key cannot inject structure"
        );
    }

    // ── ordinary owner operations can no longer brick a collection ───────────--

    function test_OutOfDomainHexColorDoesNotRevertTokenUri() public {
        // The two-step that used to brick every tokenURI: write a raw value, then declare a
        // HexColor schema for that key. The decode now clamps instead of reverting.
        SeriesCode nft = _seriesCode();
        vm.startPrank(owner);
        nft.setTokenParam(0, "palette", bytes32(type(uint256).max));
        nft.setParamSchema(
            "palette",
            IAbxConfigurableParams.ParamType.HexColor,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        vm.stopPrank();

        string memory decoded =
            TokenDataLib.decodeScalar(IAbxConfigurableParams.ParamType.HexColor, bytes32(type(uint256).max));
        assertEq(decoded, "#ffffff", "an out-of-domain colour clamps rather than reverting");
    }

    function test_SetMaxInvocationsToZeroIsRefused() public {
        SeriesImage.InitParams memory p;
        p.owner = owner;
        p.name = "S";
        p.symbol = "S";
        p.maxInvocations = 10;
        p.royaltyReceiver = owner;
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        SeriesImage nft = SeriesImage(seriesImageFactory.deploy(p));

        vm.prank(owner);
        vm.expectRevert(MaxInvocations.InvalidMaxInvocations.selector);
        nft.setMaxInvocations(0);

        // closing a drop early is still available, via the floor
        vm.prank(owner);
        nft.setMaxInvocations(1);
        assertEq(nft.maxInvocations(), 1);
    }

    // ── attacker bytes cannot escape the context they land in ────────────────--

    /// A hostile `representation` used to make the WHOLE tokenURI invalid UTF-8: `escapeJSON` is
    /// byte-level and passes bytes >= 0x80 through, so strict parsers rejected the entire document.
    function test_HighBytesInRepresentationKeepTokenUriDecodable() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = IAbxOnChainMetadata.FieldInput({
            field: "description",
            representation: bytes32(bytes.concat(hex"ff80fe81", "junk")),
            value: bytes("v")
        });
        OneOfOneImage nft = _oneOfOne(f);

        bytes memory uri = bytes(_decodeJson(nft.tokenURI(0)));
        for (uint256 i; i < uri.length; ++i) {
            assertLt(uint8(uri[i]), 0x80, "every byte of the document is ASCII");
        }
    }

    // ── round 3: the bypasses two independent workstreams landed on the round-2 fixes ──────────

    /// A param key with a high byte would make every `tokenURI` in the collection invalid UTF-8:
    /// keys render through `escapeJSON`, which is byte-level and passes >= 0x80 verbatim. This is
    /// the unswept sibling of the renderer's `_repName` fix.
    function test_NonAsciiParamKeyIsRefused() public {
        SeriesCode nft = _seriesCode();
        vm.prank(owner);
        vm.expectRevert(AbxParamsLib.InvalidParamKey.selector);
        nft.setTokenParam(0, bytes32(abi.encodePacked("size", hex"C080")), bytes32(uint256(1)));
    }

    /// An empty key has no readable name to render.
    function test_EmptyParamKeyIsRefused() public {
        SeriesCode nft = _seriesCode();
        vm.prank(owner);
        vm.expectRevert(AbxParamsLib.InvalidParamKey.selector);
        nft.setTokenParam(0, bytes32(0), bytes32(uint256(1)));
    }

    /// `lockAfter` welded the VALUE but left the schema rewritable, so a locked `Select` param's
    /// option table could still be swapped — the value a collector bought (index 0, "Ember")
    /// re-rendering as "Frost" with no param write at all.
    function test_LockedParamSchemaCannotBeRewritten() public {
        SeriesCode nft = _seriesCode();
        string[] memory opts = new string[](2);
        opts[0] = "Ember";
        opts[1] = "Ash";

        vm.prank(owner);
        nft.setParamSchema(
            "palette",
            IAbxConfigurableParams.ParamType.Select,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            uint48(block.timestamp + 1),
            bytes32(0),
            bytes32(0),
            opts
        );

        vm.warp(block.timestamp + 2); // the lock bites

        opts[0] = "Frost";
        vm.prank(owner);
        vm.expectRevert(AbxParamsLib.ParamLockExpired.selector);
        nft.setParamSchema(
            "palette",
            IAbxConfigurableParams.ParamType.Select,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            uint48(block.timestamp + 1),
            bytes32(0),
            bytes32(0),
            opts
        );
    }

    /// Hooks are owner-only forever — no dead-man release, on purpose. A transfer hook is the
    /// creator's OWN contract and is often load-bearing (work that responds to its owner), so a
    /// permissionless disarm would be a way to break a working project, not a safety valve. That a
    /// creator can wire a hook that bricks their own collection is a stated trust assumption, not a
    /// gap to engineer around.
    function test_ParamHooksAreOwnerOnlyEvenOnceOwnerless() public {
        SeriesCode nft = _seriesCode();

        vm.prank(address(0xD00D));
        vm.expectRevert();
        nft.setParamHooks(address(0), address(0), address(0));

        vm.prank(owner);
        nft.renounceOwnership();

        // nobody inherits the power when the owner walks away
        vm.prank(address(0xD00D));
        vm.expectRevert();
        nft.setParamHooks(address(0), address(0), address(0));
    }

    /// The freeze is the creator's own one-way commitment, and it still binds them.
    function test_ParamHooksFreezeBindsTheOwner() public {
        SeriesCode nft = _seriesCode();
        vm.startPrank(owner);
        nft.lockParamHooks();
        vm.expectRevert(AbxParamsLib.ParamHooksLocked.selector);
        nft.setParamHooks(address(0), address(0), address(0));
        vm.stopPrank();
    }

    // ── round 4: the one non-owner byte source that reaches the document ──────────────────────

    /// Sets up the intended "collectors name their own copy" feature: a String param the TOKEN
    /// OWNER may write. Returns the token; `collector` holds id 0.
    function _seriesWithCollectorWritableTitle() internal returns (SeriesCode nft) {
        nft = _seriesCode();
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
    }

    /// `escapeJSON` escapes quotes, backslashes and control bytes — it does NOT validate UTF-8, and
    /// bytes >= 0x80 ride through verbatim. So one malformed sequence from a COLLECTOR makes the
    /// whole `tokenURI` undecodable to a strict parser: name, image, provenance, all of it. That is
    /// a stranger griefing other holders, which no "the owner could do this anyway" argument covers.
    function test_CollectorCannotWriteMalformedUtf8IntoTheDocument() public {
        SeriesCode nft = _seriesWithCollectorWritableTitle();

        // a truncated 2-byte sequence, a bare continuation byte, and a byte that is never legal
        bytes[3] memory hostile = [bytes(hex"c328"), bytes(hex"80"), bytes(hex"ff")];
        for (uint256 i; i < hostile.length; ++i) {
            vm.prank(collector);
            vm.expectRevert(AbxParamsLib.InvalidParamValue.selector);
            nft.configureTokenParamData(0, "title", hostile[i]);
        }
    }

    /// Overlong encodings and UTF-16 surrogate halves are the two classic ways to smuggle bytes past
    /// a naive length-only check; JSON permits neither.
    function test_OverlongAndSurrogateEncodingsAreRefused() public {
        SeriesCode nft = _seriesWithCollectorWritableTitle();

        bytes[2] memory hostile = [
            bytes(hex"c0af"), // overlong "/"
            bytes(hex"eda080") // U+D800, a lone surrogate
        ];
        for (uint256 i; i < hostile.length; ++i) {
            vm.prank(collector);
            vm.expectRevert(AbxParamsLib.InvalidParamValue.selector);
            nft.configureTokenParamData(0, "title", hostile[i]);
        }
    }

    /// The check must not cost collectors the feature: real multi-byte text still writes.
    function test_ValidMultiByteUtf8StillWrites() public {
        SeriesCode nft = _seriesWithCollectorWritableTitle();

        // ASCII, é (2-byte), 世 (3-byte), 🎨 (4-byte, the U+10000 boundary) — one of each length,
        // including the U+10000 edge where the 4-byte form starts.
        bytes memory text = bytes(unicode"Étude 世 🎨");
        vm.prank(collector);
        nft.configureTokenParamData(0, "title", text);

        assertEq(nft.tokenParamData(0, "title"), text, "legitimate text is accepted and round-trips");
    }

    // ── round 5: the last two, both found on deployed code ────────────────────────────────────

    /// A schema attached to a key that ALREADY holds a contract-scope value used to freeze it
    /// forever: the raw setters are closed for governed keys and the governed path is token-scope
    /// only, so contract scope had no exit. With a malformed value that poisons every token's
    /// `tokenURI` permanently. Clearing is the safe half — it removes a fallback and cannot forge.
    function test_ContractScopeValueStaysClearableAfterASchemaLandsOnItsKey() public {
        SeriesCode nft = _seriesCode();

        vm.startPrank(owner);
        nft.setContractParam("note", bytes32(uint256(1)));
        nft.setParamSchema(
            "note",
            IAbxConfigurableParams.ParamType.Uint256Range,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );

        // the raw SETTERS stay closed — the schema still governs
        vm.expectRevert();
        nft.setContractParam("note", bytes32(uint256(2)));

        // but the owner can still get out
        nft.clearContractParam("note");
        vm.stopPrank();
    }

    /// A well-formed array still rides verbatim — the guard is shape-only, not content validation.
    function test_WellFormedAttributesStillRideVerbatim() public {
        IAbxOnChainMetadata.FieldInput[] memory f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = IAbxOnChainMetadata.FieldInput({
            field: "attributes",
            representation: "inline",
            value: bytes('  [{"trait_type":"Palette","value":"Ember"}]  ')
        });
        OneOfOneImage nft = _oneOfOne(f);

        assertTrue(
            LibString.contains(_decodeJson(nft.tokenURI(0)), '"trait_type":"Palette"'),
            "a legitimate array (even with surrounding whitespace) still embeds"
        );
    }
}
