// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// @title EIP-170 margin guard for the 200-run floor family
/// @notice Fails in CI when a guarded contract approaches the 24,576-byte deployed-code limit.
///         The guard preserves deliberate headroom; it does not optimize contract size.
///
/// @dev Sizes come from `vm.getDeployedCode`, which reads the compiled artifact — so this measures
///      exactly what would be deployed. `foundry.toml`'s `compilation_restrictions` pin these six
///      contracts (SeriesCode/SeriesCodeFactory, AbxGenerator, AbxMetadataRenderer, and
///      EditionCode/EditionCodeFactory) to `optimizer_runs = 200` in
///      EVERY profile, so a plain `forge test` sees the same bytecode `forge build --sizes` reports
///      under `FOUNDRY_PROFILE=clone-impl`; there is no profile to remember for those six.
///
///      Floors are deliberately below today's margins, not equal to them: a compiler patch release
///      moves bytecode by a few bytes, and a test that fails on jitter gets disabled rather than
///      obeyed. Each floor is tight enough to trip on any real feature addition.
///
///      **When this fails, do not raise the floor.** The floor is the point. Externalize bytes into a
///      delegatecalled library (the `AbxParamsLib` / `AbxCodeLib` pattern) — the extraction order is
///      recorded in `docs/10-backlog.md`. Extraction moves the implementation address, and
///      therefore the factory and its trust anchor, so it rides a redeploy that was happening anyway.
contract CodeSizeTest is Test {
    /// EIP-170: the maximum deployed (runtime) code size for a contract.
    uint256 internal constant EIP170_LIMIT = 24_576;

    function _margin(string memory artifact) internal view returns (uint256 size, uint256 margin) {
        size = vm.getDeployedCode(artifact).length;
        // A contract already over the limit cannot deploy at all; report 0 rather than underflow.
        margin = size >= EIP170_LIMIT ? 0 : EIP170_LIMIT - size;
    }

    function _assertMargin(string memory artifact, uint256 floor) internal {
        (uint256 size, uint256 margin) = _margin(artifact);
        emit log_named_uint(string.concat(artifact, " runtime bytes"), size);
        emit log_named_uint(string.concat(artifact, " margin"), margin);
        if (margin < floor) {
            emit log_named_uint("required margin", floor);
            revert(
                string.concat(
                    artifact,
                    " is within ",
                    vm.toString(margin),
                    " bytes of the EIP-170 limit (floor ",
                    vm.toString(floor),
                    "). Do NOT lower the floor: externalize a surface into a delegatecalled library"
                    " instead (see docs/10-backlog.md for the recommended extraction order)."
                )
            );
        }
    }

    /// The tightest one, and the reason this file exists: 193 B of headroom at the time of writing.
    /// The floor catches meaningful growth while tolerating compiler-patch jitter.
    function test_SeriesCodeHasEip170Margin() public {
        _assertMargin("SeriesCode.sol:SeriesCode", 600);
    }

    /// The factory `new`s the implementation, so it shares the compilation unit and the 200-run floor.
    /// Comfortable today (~22 KB); guarded so it can't quietly become the binding constraint.
    function test_SeriesCodeFactoryHasEip170Margin() public {
        _assertMargin("SeriesCodeFactory.sol:SeriesCodeFactory", 2_000);
    }

    /// Pure eth_call surfaces on the same floor. Both have room now; both grow with each spec version
    /// Both public renderers retain enough room for meaningful maintenance changes.
    function test_AbxGeneratorHasEip170Margin() public {
        _assertMargin("AbxGenerator.sol:AbxGenerator", 2_000);
    }

    function test_AbxMetadataRendererHasEip170Margin() public {
        _assertMargin("AbxMetadataRenderer.sol:AbxMetadataRenderer", 2_000);
    }

    // ── ERC-1155 editions ───────────────────────────────────────────────────────────────────────
    // Edition contracts delegate their larger URI, creator-token, supply, and mint bookkeeping
    // surfaces to {AbxEditionLib}. The library and linked factories are deployed deterministically;
    // changing a linked library still requires the full redeploy checklist.

    function test_EditionImageHasEip170Margin() public {
        // 2,847 B margin after delegating to AbxEditionLib, under the default (max-runs) profile —
        // EditionImage is not in `compilation_restrictions`, unlike EditionCode.
        _assertMargin("EditionImage.sol:EditionImage", 1_000);
    }

    function test_EditionImageFactoryHasEip170Margin() public {
        _assertMargin("EditionImageFactory.sol:EditionImageFactory", 2_000);
    }

    function test_OneOfOneEditionHasEip170Margin() public {
        // 3,889 B margin after delegating to AbxEditionLib.
        _assertMargin("OneOfOneEdition.sol:OneOfOneEdition", 2_000);
    }

    function test_OneOfOneEditionFactoryHasEip170Margin() public {
        _assertMargin("OneOfOneEditionFactory.sol:OneOfOneEditionFactory", 2_000);
    }

    function test_AbxFixedPriceMinter1155HasEip170Margin() public {
        _assertMargin("AbxFixedPriceMinter1155.sol:AbxFixedPriceMinter1155", 2_000);
    }

    /// The factory itself is small (it only `new`s the implementation); the implementation is the
    /// tight one — see {test_EditionCodeHasEip170Margin}.
    function test_EditionCodeFactoryHasEip170Margin() public {
        _assertMargin("EditionCodeFactory.sol:EditionCodeFactory", 2_000);
    }

    /// Tightest edition floor, for the same reason {test_SeriesCodeHasEip170Margin} is tightest
    /// among the pre-existing rows: 220 B of headroom at the time of writing, after {AbxEditionLib}
    /// closed the ~2,185 B gap. The floor catches meaningful growth while tolerating
    /// compiler-patch jitter.
    function test_EditionCodeHasEip170Margin() public {
        _assertMargin("EditionCode.sol:EditionCode", 600);
    }

    // Delegatecalled libraries are subject to EIP-170 too. Their looser floors catch large
    // regressions without policing ordinary growth.

    function test_AbxParamsLibHasEip170Margin() public {
        _assertMargin("AbxParamsLib.sol:AbxParamsLib", 5_000);
    }

    function test_AbxCodeLibHasEip170Margin() public {
        _assertMargin("AbxCodeLib.sol:AbxCodeLib", 5_000);
    }

    function test_AbxMetadataLibHasEip170Margin() public {
        _assertMargin("AbxMetadataLib.sol:AbxMetadataLib", 5_000);
    }

    function test_AbxEditionLibHasEip170Margin() public {
        _assertMargin("AbxEditionLib.sol:AbxEditionLib", 5_000);
    }
}
