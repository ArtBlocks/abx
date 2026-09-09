// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";
import {
    IAbxConfigurableParams
} from "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {IAbxAugmentHook} from "../src/extensions/configurable-params/IAbxParamHooks.sol";
import {MaxDataLengthConfigureHook} from "../src/reference/MaxDataLengthConfigureHook.sol";
import {TransferCounterHook} from "../src/reference/TransferCounterHook.sol";
import {TransferCountAugmentHook} from "../src/reference/TransferCountAugmentHook.sol";

/// The harness uses the real canonical clone, not a lookalike MockAbxToken. These tests therefore
/// pin hook ordering, empty-data refusal, authorization and transfer callbacks to protocol behavior.
contract ReferenceHooksTest is Test {
    SeriesCode internal token;
    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");
    address internal recipient = makeAddr("recipient");

    function setUp() public {
        SeriesCodeFactory factory = new SeriesCodeFactory();
        token = SeriesCode(factory.deploy(_params()));
    }

    function _params() private view returns (SeriesCode.InitParams memory) {
        return SeriesCode.InitParams({
            owner: owner,
            name: "Reference",
            symbol: "REF",
            tokenURIBase: "https://example.invalid/t",
            tokenURIRenderer: address(0),
            contractURIBase: "https://example.invalid/c",
            contractURIRenderer: address(0),
            royaltyReceiver: owner,
            royaltyBps: 0,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            maxInvocations: 3,
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            seedSource: address(0),
            disableTokenOwnerDelegation: true,
            mintTo: address(0),
            mintCount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    function test_ReferencesComposeAgainstCanonicalSeriesCode() public {
        MaxDataLengthConfigureHook configure = new MaxDataLengthConfigureHook(address(token), 8);
        TransferCounterHook transfers = new TransferCounterHook(address(token));
        TransferCountAugmentHook augment = new TransferCountAugmentHook(transfers);

        vm.startPrank(owner);
        token.setParamSchema(
            "title",
            IAbxConfigurableParams.ParamType.String,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        token.setParamHooks(address(configure), address(augment), address(transfers));
        uint256 id = token.mint(collector);
        vm.stopPrank();

        vm.prank(collector);
        token.configureTokenParamData(id, "title", bytes("small"));
        assertEq(token.tokenParamData(id, "title"), bytes("small"));

        vm.prank(collector);
        vm.expectRevert(
            abi.encodeWithSelector(MaxDataLengthConfigureHook.DataTooLarge.selector, 9, 8)
        );
        token.configureTokenParamData(id, "title", bytes("too-large"));

        vm.prank(collector);
        token.transferFrom(collector, recipient, id);
        assertEq(transfers.transferCount(id), 1);

        IAbxAugmentHook.AugmentedParam[] memory augmented =
            augment.augmentTokenParams(address(token), id);
        assertEq(augmented[0].value, "1");
    }

    function test_TransferHookRejectsForgedDirectCallback() public {
        TransferCounterHook transfers = new TransferCounterHook(address(token));

        vm.expectRevert(TransferCounterHook.OnlyToken.selector);
        transfers.onTokenTransfer(0, collector, recipient, collector, 1);

        assertEq(transfers.transferCount(0), 0);
    }

    function test_EmptyBlobIsRejectedByTheRealTokenBeforeTheHook() public {
        MaxDataLengthConfigureHook configure = new MaxDataLengthConfigureHook(address(token), 8);
        vm.startPrank(owner);
        token.setParamSchema(
            "title",
            IAbxConfigurableParams.ParamType.String,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        token.setParamHooks(address(configure), address(0), address(0));
        uint256 id = token.mint(collector);
        vm.stopPrank();
        vm.prank(collector);
        vm.expectRevert();
        token.configureTokenParamData(id, "title", bytes(""));
    }
}
