// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {IAbxParams} from "../src/extensions/params/IAbxParams.sol";
import {IAbxConfigurableParams} from
    "../src/extensions/configurable-params/IAbxConfigurableParams.sol";

/// @dev An augment hook with code, for the "re-pointing the augment hook refreshes metadata" case.
contract StubHook {
    function augmentTokenData(address, uint256) external pure returns (string memory) {
        return "";
    }
}

/// @title Params write-path hardening
/// @notice Each case pins one rule {AbxParamsLib} enforces at the write choke point: errors carry the
///         context an integrator needs to read them, hooks must have code, augment re-points refresh
///         metadata, blobs are bounded before they are written, and a schema cannot declare
///         constraints the chain will not enforce.
contract ParamsHardeningTest is Test {
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    event HooksConfigured(address configureHook, address augmentHook, address transferHook);

    SeriesCodeFactory internal factory;
    SeriesCode internal nft;
    address internal owner = address(0xA11CE);
    address internal collector = address(0xC011);
    address internal stranger = address(0x5757);
    address internal controller = address(0xC0DE);

    function setUp() public {
        factory = new SeriesCodeFactory();
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
        nft = SeriesCode(factory.deploy(p));
    }

    function _schema(
        bytes32 key,
        IAbxConfigurableParams.ParamType t,
        IAbxConfigurableParams.AuthOption auth,
        address authAddress,
        bytes32 min,
        bytes32 max,
        string[] memory options
    ) internal {
        vm.prank(owner);
        nft.setParamSchema(key, t, auth, authAddress, 0, min, max, options);
    }

    // ── errors carry the enforced auth ───────────────────────────────────────────────────────

    /// The error that integrators misread as "creator only" now says which auth was enforced and
    /// which address the Address leg names, so the reason is readable from the revert alone.
    function test_NotParamAuthorizedNamesTheEnforcedAuth() public {
        _schema(
            "mood",
            IAbxConfigurableParams.ParamType.Bool,
            IAbxConfigurableParams.AuthOption.TokenOwnerOrAddress,
            controller,
            0,
            0,
            new string[](0)
        );
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAbxConfigurableParams.NotParamAuthorized.selector,
                bytes32("mood"),
                0,
                stranger,
                IAbxConfigurableParams.AuthOption.TokenOwnerOrAddress,
                controller
            )
        );
        nft.configureTokenParam(0, "mood", bytes32(uint256(1)));

        // both named parties still pass
        vm.prank(collector);
        nft.configureTokenParam(0, "mood", bytes32(uint256(1)));
        vm.prank(controller);
        nft.configureTokenParam(0, "mood", bytes32(0));
    }

    // ── hooks ────────────────────────────────────────────────────────────────────────────────

    /// A codeless hook reverts every call to it with empty data — for a transfer hook, every mint
    /// and transfer — so it is refused when set, for each of the three roles.
    function test_CodelessHookIsRefused() public {
        address eoa = address(0xDEAD);
        bytes memory err =
            abi.encodeWithSelector(IAbxConfigurableParams.InvalidParamHook.selector, eoa);
        vm.startPrank(owner);
        vm.expectRevert(err);
        nft.setParamHooks(eoa, address(0), address(0));
        vm.expectRevert(err);
        nft.setParamHooks(address(0), eoa, address(0));
        vm.expectRevert(err);
        nft.setParamHooks(address(0), address(0), eoa);
        vm.stopPrank();
    }

    /// The augment hook contributes to every token's tokenData, so re-pointing it is an
    /// output change and pings ERC-4906 for the whole collection.
    function test_AugmentHookChangeRefreshesMetadata() public {
        address hook = address(new StubHook());
        vm.prank(owner);
        vm.expectEmit(address(nft));
        emit HooksConfigured(address(0), hook, address(0));
        vm.expectEmit(address(nft));
        emit BatchMetadataUpdate(0, type(uint256).max);
        nft.setParamHooks(address(0), hook, address(0));
    }

    /// Re-pointing only the configure or transfer hook leaves output untouched: no 4906 ping.
    function test_NonAugmentHookChangeDoesNotRefreshMetadata() public {
        address hook = address(new StubHook());
        vm.recordLogs();
        vm.prank(owner);
        nft.setParamHooks(hook, address(0), hook);
        assertEq(vm.getRecordedLogs().length, 1, "HooksConfigured only");
    }

    // ── blobs ────────────────────────────────────────────────────────────────────────────────

    /// One byte past what an SSTORE2 contract can hold is refused up front, with the key and the
    /// length, instead of failing inside CREATE after burning the forwarded gas.
    function test_OversizedBlobIsRefusedBeforeWriting() public {
        bytes memory big = new bytes(24_576);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAbxParams.ParamDataTooLarge.selector, bytes32("sprite"), uint256(24_576)
            )
        );
        nft.setTokenParamData(0, "sprite", big);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAbxParams.ParamDataTooLarge.selector, bytes32("sprite"), uint256(24_576)
            )
        );
        nft.setContractParamData("sprite", big);
    }

    /// The ceiling itself fits.
    function test_MaxSizeBlobIsAccepted() public {
        bytes memory max = new bytes(24_575);
        max[24_574] = 0x01;
        vm.prank(owner);
        nft.setTokenParamData(0, "sprite", max);
        assertEq(nft.tokenParamData(0, "sprite").length, 24_575);
    }

    /// The governed and raw blob paths now refuse an empty value with the same error.
    function test_EmptyBlobIsTheSameErrorOnBothPaths() public {
        _schema(
            "title",
            IAbxConfigurableParams.ParamType.String,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            0,
            new string[](0)
        );
        bytes memory err =
            abi.encodeWithSelector(IAbxParams.EmptyParamValue.selector, bytes32("title"));
        vm.prank(collector);
        vm.expectRevert(err);
        nft.configureTokenParamData(0, "title", "");

        bytes memory rawErr =
            abi.encodeWithSelector(IAbxParams.EmptyParamValue.selector, bytes32("notes"));
        vm.prank(owner);
        vm.expectRevert(rawErr);
        nft.setTokenParamData(0, "notes", "");
    }

    /// A contract-scope `seed` stays writable as a literal (it is no token's seed), but is never a
    /// blob — the same shape rule as token scope.
    function test_ContractScopeSeedIsNeverABlob() public {
        vm.startPrank(owner);
        nft.setContractParam("seed", bytes32(uint256(7)));
        vm.expectRevert(IAbxParams.SeedSettled.selector);
        nft.setContractParamData("seed", bytes("x"));
        vm.stopPrank();
    }

    // ── schemas declare only what the chain enforces ─────────────────────────────────────────

    /// `min`/`max` bound only the range types. Anywhere else they would be stored, emitted and
    /// shown by a UI, but never enforced, so they are refused.
    function test_BoundsOnUnboundedTypesAreRefused() public {
        IAbxConfigurableParams.ParamType[4] memory unbounded = [
            IAbxConfigurableParams.ParamType.Bool,
            IAbxConfigurableParams.ParamType.HexColor,
            IAbxConfigurableParams.ParamType.String,
            IAbxConfigurableParams.ParamType.Bytes
        ];
        for (uint256 i; i < unbounded.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAbxConfigurableParams.InvalidParamSchema.selector, bytes32("k")
                )
            );
            nft.setParamSchema(
                "k",
                unbounded[i],
                IAbxConfigurableParams.AuthOption.Creator,
                address(0),
                0,
                bytes32(0),
                bytes32(uint256(10)),
                new string[](0)
            );
        }
        string[] memory options = new string[](1);
        options[0] = "a";
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IAbxConfigurableParams.InvalidParamSchema.selector, bytes32("k"))
        );
        nft.setParamSchema(
            "k",
            IAbxConfigurableParams.ParamType.Select,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            0,
            bytes32(uint256(1)),
            bytes32(0),
            options
        );
    }

    /// The range types still accept bounds.
    function test_BoundsOnRangeTypesAreAccepted() public {
        _schema(
            "n",
            IAbxConfigurableParams.ParamType.Uint256Range,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            bytes32(uint256(1)),
            bytes32(uint256(10)),
            new string[](0)
        );
        (, , , , , bytes32 min, bytes32 max,) = nft.paramSchemaHead("n");
        assertEq(uint256(min), 1);
        assertEq(uint256(max), 10);
    }

    /// A Select label renders verbatim into tokenData; a malformed one would make every selecting
    /// token's document undecodable, and an empty one is indistinguishable from "no option".
    function test_SelectLabelsMustBeNonEmptyUtf8() public {
        bytes[3] memory bad = [bytes(""), bytes(hex"c328"), bytes(hex"ff")];
        for (uint256 i; i < bad.length; ++i) {
            string[] memory options = new string[](2);
            options[0] = "ok";
            options[1] = string(bad[i]);
            vm.prank(owner);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAbxConfigurableParams.InvalidParamSchema.selector, bytes32("pick")
                )
            );
            nft.setParamSchema(
                "pick",
                IAbxConfigurableParams.ParamType.Select,
                IAbxConfigurableParams.AuthOption.Creator,
                address(0),
                0,
                bytes32(0),
                bytes32(0),
                options
            );
        }
        // multi-byte UTF-8 is fine
        string[] memory good = new string[](2);
        good[0] = unicode"Ember";
        good[1] = unicode"Fröst";
        _schema(
            "pick",
            IAbxConfigurableParams.ParamType.Select,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            0,
            0,
            good
        );
        assertEq(nft.selectOption("pick", 1), unicode"Fröst");
    }
}
