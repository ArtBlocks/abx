// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the canonical {AbxMetadataRenderer} — the shared, stateless on-chain
///         metadata renderer that fully-on-chain tokens point at. One deployment serves
///         every ABX token on the chain.
contract DeployRenderer is Script {
    /// @dev Idempotent, via {AbxLink-deploy}: the keyless CREATE2 proxy REVERTS on an occupied
    ///      address, so a bare `new X{salt}()` turns "this chain is already set up" into an opaque
    ///      failure. Re-running is the normal way to finish a partial bootstrap, and during the
    ///      2026-08-13 deploy two scripts did exactly this — the chunk store aborted on both chains
    ///      because its bytecode was unchanged and the address was already occupied.
    function run() external returns (AbxMetadataRenderer renderer) {
        vm.startBroadcast();
        renderer = AbxMetadataRenderer(AbxLink.deploy(AbxSalts.RENDERER, AbxLink.initCode("AbxMetadataRenderer"), "AbxMetadataRenderer"));
        vm.stopBroadcast();

        console2.log("AbxMetadataRenderer:", address(renderer));
        console2.log("specVersion:          ", renderer.specVersion());
    }
}
