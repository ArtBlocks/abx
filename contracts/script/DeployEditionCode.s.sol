// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {EditionCodeFactory} from "../src/factories/EditionCodeFactory.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the code-project trust anchor: the canonical {EditionCodeFactory}, which deploys the
///         implementation in its constructor. The shared {AbxMetadataRenderer} and
///         {AbxChunkStore} are reused ({DeployRenderer}); {AbxSeedSource} is deployed
///         separately ({DeploySeedSource}).
///
/// @dev **Deploy order.** {DeployLibraries} must have run on this chain first. This script does not
///      accept library addresses and does not use `--libraries`: it recomputes the canonical library
///      addresses from {AbxSalts} and substitutes them into the compiled artifact post-compile, then
///      CREATE2s the result through the keyless proxy. See {AbxLink} for why that method — and not
///      `--libraries` — is the one that keeps this factory's address identical to the address the SDK
///      predicts for the same build.
///
///      `--sig 'predict()'` prints the factory address without sending anything.
contract DeployEditionCode is Script {
    function run() external returns (EditionCodeFactory factory) {
        vm.startBroadcast();
        factory = EditionCodeFactory(AbxLink.deploy(AbxSalts.EDITION_CODE_FACTORY, _initCode(), "EditionCodeFactory"));
        vm.stopBroadcast();

        console2.log("implementation:", factory.implementation());
    }

    /// @notice Print the factory address without sending anything.
    function predict() external view {
        console2.log("EditionCodeFactory", AbxLink.predict(AbxSalts.EDITION_CODE_FACTORY, _initCode()));
    }

    function _initCode() private view returns (bytes memory) {
        return AbxLink.initCode("EditionCodeFactory", AbxLink.editionCodeLibs());
    }
}
