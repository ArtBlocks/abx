// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {IAbxConfigurableParams} from
    "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

contract GasSeedSource is IAbxSeedSource {
    function seed(uint256 tokenId, address) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("gas", tokenId));
    }
}

/// @notice **The published cost model for a PostParam write.** A creator writing a minter that
///         calls `configureTokenParam*` has to choose a gas budget for it, and there was nothing to
///         look it up in — a 2026-08-24 field report described discovering the real number three
///         times by hardcoding a guess, watching a demo-mode transaction revert with `status: 0`,
///         and re-measuring with `cast estimate` (400k assumed → 480,081 → 741,193 as fields were
///         added).
///
/// @dev These are MEASUREMENTS, not limits — the asserted bands are wide and one-sided, so they
///      fail only on a real regression (a write getting materially more expensive) rather than on
///      compiler noise. The numbers printed here are what
///      `site/content/docs/protocol/params.mdx` publishes; re-run with `-vv` and update both
///      together. The dominant term is **cold vs warm**: a first-ever write to a key pays a fresh
///      SSTORE plus an append to the enumeration list, an overwrite pays neither.
contract PostParamGasTest is Test {
    SeriesCodeFactory internal factory;
    GasSeedSource internal seedSource;
    SeriesCode internal nft;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");

    bytes32 internal constant SCALAR_A = "tint";
    bytes32 internal constant SCALAR_B = "glow";
    bytes32 internal constant BLOB = "placements";

    uint256 internal tokenId;

    function setUp() public {
        factory = new SeriesCodeFactory();
        seedSource = new GasSeedSource();
        nft = SeriesCode(factory.deploy(_params(address(seedSource))));

        vm.startPrank(owner);
        _declare(SCALAR_A, IAbxConfigurableParams.ParamType.Uint256Range);
        _declare(SCALAR_B, IAbxConfigurableParams.ParamType.Uint256Range);
        _declare(BLOB, IAbxConfigurableParams.ParamType.Bytes);
        tokenId = nft.mint(collector);
        vm.stopPrank();
    }

    function _declare(bytes32 key, IAbxConfigurableParams.ParamType t) internal {
        nft.setParamSchema(
            key,
            t,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
    }

    function _params(address src) internal view returns (SeriesCode.InitParams memory) {
        return SeriesCode.InitParams({
            owner: owner,
            name: "Gas",
            symbol: "GAS",
            tokenURIBase: "https://abx.test/t",
            tokenURIRenderer: address(0),
            contractURIBase: "https://abx.test/c",
            contractURIRenderer: address(0),
            royaltyReceiver: owner,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            maxInvocations: 10,
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            seedSource: src,
            disableTokenOwnerDelegation: false,
            mintTo: address(0),
            mintCount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    /// @dev A scalar write: cold (first-ever for this key) vs warm (overwrite).
    function test_ScalarWriteCostsColdVsWarm() public {
        vm.startPrank(collector);

        uint256 g0 = gasleft();
        nft.configureTokenParam(tokenId, SCALAR_A, bytes32(uint256(1)));
        uint256 cold = g0 - gasleft();

        g0 = gasleft();
        nft.configureTokenParam(tokenId, SCALAR_A, bytes32(uint256(2)));
        uint256 warm = g0 - gasleft();

        vm.stopPrank();

        emit log_named_uint("scalar cold (first write to a key)", cold);
        emit log_named_uint("scalar warm (overwrite)", warm);

        assertLt(cold, 200_000, "a cold scalar PostParam write got materially more expensive");
        assertLt(warm, 80_000, "a warm scalar PostParam overwrite got materially more expensive");
        assertLt(warm, cold, "an overwrite must be cheaper than a first write");
    }

    /// @dev A `Bytes`/`String` write: one SSTORE2 blob per write, so the payload dominates and an
    ///      "overwrite" still deploys a fresh blob — the warm saving is only the key's bookkeeping.
    function test_BlobWriteCostsColdVsWarm() public {
        bytes memory small = new bytes(32);
        bytes memory large = new bytes(512);

        vm.startPrank(collector);

        uint256 g0 = gasleft();
        nft.configureTokenParamData(tokenId, BLOB, small);
        uint256 cold32 = g0 - gasleft();

        g0 = gasleft();
        nft.configureTokenParamData(tokenId, BLOB, small);
        uint256 warm32 = g0 - gasleft();

        g0 = gasleft();
        nft.configureTokenParamData(tokenId, BLOB, large);
        uint256 warm512 = g0 - gasleft();

        vm.stopPrank();

        emit log_named_uint("blob cold, 32 bytes", cold32);
        emit log_named_uint("blob warm, 32 bytes", warm32);
        emit log_named_uint("blob warm, 512 bytes", warm512);
        emit log_named_uint("marginal gas per byte (512 vs 32)", (warm512 - warm32) / (512 - 32));

        assertLt(cold32, 300_000, "a cold 32-byte blob PostParam write got materially more expensive");
        assertLt(warm32, cold32, "an overwrite must be cheaper than a first write");
        assertGt(warm512, warm32, "a bigger payload must cost more");
    }

    /// @dev What a minter that configures N params in one mint actually pays — the shape the field
    ///      report was estimating by hand. All cold, because a fresh token has written nothing.
    function test_SeveralColdWritesInOneTransaction() public {
        vm.startPrank(owner);
        uint256 second = nft.mint(collector);
        vm.stopPrank();

        vm.startPrank(collector);
        uint256 g0 = gasleft();
        nft.configureTokenParam(second, SCALAR_A, bytes32(uint256(7)));
        nft.configureTokenParam(second, SCALAR_B, bytes32(uint256(9)));
        nft.configureTokenParamData(second, BLOB, new bytes(64));
        uint256 total = g0 - gasleft();
        vm.stopPrank();

        emit log_named_uint("two cold scalars + one cold 64-byte blob", total);
        assertLt(total, 600_000, "the three-cold-write shape got materially more expensive");
    }
}
