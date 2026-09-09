// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {EditionCode} from "../src/tokens/EditionCode.sol";
import {EditionCodeFactory} from "../src/factories/EditionCodeFactory.sol";
import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {
    IAbxConfigurableParams
} from "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {IAbxFieldRenderer} from "../src/uri/IAbxFieldRenderer.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";
import {AbxParamsLib} from "../src/libraries/AbxParamsLib.sol";

/// @dev A project-owned seed source that changes seed governance during the first draw.
contract RegressionReentrantSeedOwner is IAbxSeedSource {
    SeriesCode internal token;

    function setToken(SeriesCode token_) external {
        token = token_;
    }

    function mintTo(address to) external {
        token.mint(to);
    }

    function rewriteSeed(uint256 tokenId, bytes32 value) external {
        token.configureTokenParam(tokenId, "seed", value);
    }

    function seed(uint256, address) external returns (bytes32) {
        token.setParamSchema(
            "seed",
            IAbxConfigurableParams.ParamType.Uint256Range,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        return bytes32(uint256(1));
    }
}

contract RegressionImageLocatorRenderer is IAbxFieldRenderer {
    function render(address, uint256, bytes32)
        external
        pure
        returns (string memory contentType, bytes memory data)
    {
        return ("text/uri-list", bytes("ipfs://Qm/x.png"));
    }
}

/// @dev A normal transfer-derived param hook. It has no way to distinguish a zero-value edition
///      transfer because the hook ABI carries no amount.
contract RegressionEditionTransferHook {
    EditionCode internal token;

    function setToken(EditionCode token_) external {
        token = token_;
    }

    function onTokenTransfer(uint256 tokenId, address, address to, address, uint256) external {
        token.configureTokenParam(tokenId, "lastTo", bytes32(uint256(uint160(to))));
    }
}

/// @dev Records every argument the widened hook ABI delivers, so `operator` and `amount` are proven
///      to arrive rather than assumed. Without them a hook on a shared-supply edition cannot tell a
///      real transfer from a no-op.
contract RegressionRecordingEditionHook {
    struct Call {
        uint256 tokenId;
        address from;
        address to;
        address operator;
        uint256 amount;
    }

    Call[] public calls;

    function count() external view returns (uint256) {
        return calls.length;
    }

    function onTokenTransfer(uint256 tokenId, address from, address to, address operator, uint256 amount)
        external
    {
        calls.push(Call(tokenId, from, to, operator, amount));
    }
}

/// @notice Security regression tests retain the exploit setup while asserting the closed behavior.
contract SecurityRegressionTest is Test {
    function test_ZeroAmountAndSelfTransfersDoNotInvokeTheParamLifecycle() public {
        EditionCodeFactory factory = new EditionCodeFactory();
        RegressionEditionTransferHook hook = new RegressionEditionTransferHook();
        address holder = address(0xB0B);
        address attacker = address(0xBAD);

        EditionCode.InitParams memory p;
        p.owner = address(this);
        p.name = "Regression Edition";
        p.symbol = "AED";
        p.royaltyReceiver = address(this);
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        p.maxInvocations = 10;
        p.editionSize = 10;
        p.mintTo = holder;
        p.mintCount = 1;
        p.mintAmount = 1;

        EditionCode token = EditionCode(factory.deploy(p));
        hook.setToken(token);
        token.setParamSchema(
            "lastTo",
            IAbxConfigurableParams.ParamType.Uint256Range,
            IAbxConfigurableParams.AuthOption.Address,
            address(hook),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        token.setParamHooks(address(0), address(0), address(hook));

        // Solady permits this call from any
        // caller because zero is not greater than a zero balance, so before the fix a stranger
        // holding no copy could fire the param lifecycle for any id and pick the stored value that
        // every real holder then renders.
        assertEq(token.balanceOf(attacker, 0), 0, "the attacker owns no copy");
        vm.prank(attacker);
        token.safeTransferFrom(attacker, holder, 0, 0, "");

        assertEq(token.balanceOf(attacker, 0), 0, "no attacker balance changed");
        assertEq(token.balanceOf(holder, 0), 1, "no holder balance changed");
        (,, bool isSet) = token.tokenParam(0, "lastTo");
        assertFalse(isSet, "a zero-amount transfer must not invoke the hook");

        // The other half of the same skip: a real balance, but the ownership set is unchanged.
        vm.prank(holder);
        token.safeTransferFrom(holder, holder, 0, 1, "");
        (,, bool setAfterSelf) = token.tokenParam(0, "lastTo");
        assertFalse(setAfterSelf, "a self-transfer must not invoke the hook either");

        // And a REAL transfer still does — the skip must not have disarmed the feature.
        vm.prank(holder);
        token.safeTransferFrom(holder, attacker, 0, 1, "");
        (bytes32 lastTo,, bool setAfterReal) = token.tokenParam(0, "lastTo");
        assertTrue(setAfterReal, "a real transfer still drives the lifecycle");
        assertEq(lastTo, bytes32(uint256(uint160(attacker))), "with the real recipient");
    }

    /// A batch carrying a mix of real and zero amounts must notify for the real entries ONLY, and
    /// must deliver the operator and per-entry amount the widened ABI promises.
    function test_BatchSkipsZeroEntriesAndDeliversOperatorAndAmount() public {
        EditionCodeFactory factory = new EditionCodeFactory();
        RegressionRecordingEditionHook hook = new RegressionRecordingEditionHook();
        address holder = address(0xB0B);
        address buyer = address(0xCAFE);
        address operator = address(0x09E9A704);

        EditionCode.InitParams memory p;
        p.owner = address(this);
        p.name = "Batch";
        p.symbol = "BAT";
        p.royaltyReceiver = address(this);
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        p.maxInvocations = 10;
        p.editionSize = 10;
        p.mintTo = holder;
        p.mintCount = 2; // ids 0 and 1
        p.mintAmount = 5;

        EditionCode token = EditionCode(factory.deploy(p));
        token.setParamHooks(address(0), address(0), address(hook));

        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = 0;
        amounts[0] = 3; // real
        ids[1] = 1;
        amounts[1] = 0; // no-op rider

        vm.prank(holder);
        token.setApprovalForAll(operator, true);
        vm.prank(operator);
        token.safeBatchTransferFrom(holder, buyer, ids, amounts, "");

        assertEq(hook.count(), 1, "only the entry that actually moved is notified");
        (uint256 id, address from, address to, address op, uint256 amount) = hook.calls(0);
        assertEq(id, 0);
        assertEq(from, holder);
        assertEq(to, buyer);
        assertEq(op, operator, "operator is the approved caller, not the holder");
        assertEq(amount, 3, "the per-entry amount, not the batch");
    }

    function test_FirstSeedCallbackCannotInstallARewriteSchema() public {
        SeriesCodeFactory factory = new SeriesCodeFactory();
        RegressionReentrantSeedOwner sourceAndOwner = new RegressionReentrantSeedOwner();

        SeriesCode.InitParams memory p;
        p.owner = address(sourceAndOwner);
        p.name = "Regression";
        p.symbol = "REG";
        p.royaltyReceiver = address(sourceAndOwner);
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        p.maxInvocations = 10;
        p.seedSource = address(sourceAndOwner);

        SeriesCode token = SeriesCode(factory.deploy(p));
        sourceAndOwner.setToken(token);

        // The governance latch is set before
        // the external seed-source call, so the reentrant declaration is refused and the whole mint
        // reverts. What a buyer read before the sale is what governs after it.
        (bool existedBefore,,,,,,,) = token.paramSchema("seed");
        assertFalse(existedBefore, "the buyer-visible pre-mint state has no seed schema");

        vm.expectRevert(AbxParamsLib.SeedSettled.selector);
        sourceAndOwner.mintTo(address(0xB0B));

        // The latch unwound with the reverted mint: nothing was drawn, so nothing is settled and the
        // key stays open to an HONEST pre-sale declaration.
        (bool existsAfter,,,,,,,) = token.paramSchema("seed");
        assertFalse(existsAfter, "no schema was installed");
        (,, bool seedSet) = token.tokenParam(0, "seed");
        assertFalse(seedSet, "and no seed persisted");
    }

    /// The latch must not close the key for a project that never draws a seed — the commitment is
    /// about seeds that exist, not about having minted.
    function test_ProjectWithNoSeedSourceMayStillDeclareASeedSchemaAfterMinting() public {
        SeriesCodeFactory factory = new SeriesCodeFactory();
        SeriesCode.InitParams memory p;
        p.owner = address(this);
        p.name = "NoSeed";
        p.symbol = "NS";
        p.royaltyReceiver = address(this);
        p.royaltyBps = 500;
        p.maxRoyaltyBps = 1000;
        p.maxInvocations = 10;
        p.mintTo = address(0xB0B);
        p.mintCount = 1; // minted, but seedSource is zero so no seed was ever drawn

        SeriesCode token = SeriesCode(factory.deploy(p));
        token.setParamSchema(
            "seed",
            IAbxConfigurableParams.ParamType.Uint256Range,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        (bool exists,,,,,,,) = token.paramSchema("seed");
        assertTrue(exists, "no seed was drawn, so the key is still open");
    }

    function test_ComputedImageLocatorLandsVerbatim() public {
        OneOfOneImageFactory factory = new OneOfOneImageFactory();
        AbxMetadataRenderer metadataRenderer = new AbxMetadataRenderer();
        RegressionImageLocatorRenderer imageRenderer = new RegressionImageLocatorRenderer();

        IAbxOnChainMetadata.FieldInput[] memory tokenFields = new IAbxOnChainMetadata.FieldInput[](1);
        tokenFields[0] = IAbxOnChainMetadata.FieldInput({
            field: "image", representation: "renderer", value: abi.encode(address(imageRenderer))
        });
        IAbxOnChainMetadata.FieldInput[] memory contractFields = new IAbxOnChainMetadata.FieldInput[](0);
        OneOfOneImage token = OneOfOneImage(
            factory.deploy(
                OneOfOneImage.InitParams({
                    owner: address(this),
                    mintTo: address(0xB0B),
                    name: "Regression",
                    symbol: "REG",
                    tokenURIBase: "",
                    tokenURIRenderer: address(metadataRenderer),
                    contractURIBase: "",
                    contractURIRenderer: address(metadataRenderer),
                    royaltyReceiver: address(this),
                    royaltyBps: 500,
                    maxRoyaltyBps: 1000,
                    burnable: false,
                    transferValidator: address(0),
                    tokenFields: tokenFields,
                    contractFields: contractFields
                })
            )
        );

        string memory uri = token.tokenURI(0);
        string memory prefix = "data:application/json;base64,";
        string memory json =
            string(Base64.decode(LibString.slice(uri, bytes(prefix).length, bytes(uri).length)));
        // `image` and `animation_url` share one
        // URI-valued-field helper, so a renderer declaring `text/uri-list` (RFC 2483: "this payload
        // is a URI") lands verbatim on BOTH. Before, only `animation_url` honored the rule and a
        // computed `image` came out as `data:text/uri-list;base64,…`, which nothing dereferences.
        string memory wrapped = string.concat(
            '"image":"data:text/uri-list;base64,', Base64.encode(bytes("ipfs://Qm/x.png")), '"'
        );
        assertFalse(LibString.contains(json, wrapped), "the locator is not data-wrapped");
        assertTrue(
            LibString.contains(json, '"image":"ipfs://Qm/x.png"'),
            "the locator lands verbatim, as the protocol rule says"
        );

        // Provenance reports the ROUTE, not a guess about the destination: these bytes were computed
        // on chain, which is true, and it makes no claim about where `ipfs://` resolves.
        assertTrue(
            LibString.contains(json, '"field":"image","source":"renderer"'),
            "source names the route the bytes took"
        );
        assertFalse(LibString.contains(json, '"onChain"'), "no un-knowable on-chain claim");
        assertFalse(LibString.contains(json, "verifiedAgainstChain"), "no dead always-null member");
    }
}
