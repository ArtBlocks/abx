// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AbxSeedSource} from "../src/seed/AbxSeedSource.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the canonical {AbxSeedSource} — the shared, ownerless pseudorandom mint-time
///         seed source — on its OWN, so it compiles under the default profile (not dragged into the
///         SeriesCode `clone-impl` 200-run unit). CREATE2 via {AbxSalts}, so the address is identical
///         on every chain and matches the SDK's `generated.ts` bytecode. Keep it standalone: bundling
///         it with {DeploySeriesCode} (which pulls in the size-restricted factory) compiles it under
///         clone-impl and yields a different, non-canonical address.
contract DeploySeedSource is Script {
    /// @dev Idempotent, via {AbxLink-deploy}: the keyless CREATE2 proxy REVERTS on an occupied
    ///      address, so a bare `new X{salt}()` turns "this chain is already set up" into an opaque
    ///      failure. Re-running is the normal way to finish a partial bootstrap, and during the
    ///      2026-08-13 deploy two scripts did exactly this — the chunk store aborted on both chains
    ///      because its bytecode was unchanged and the address was already occupied.
    function run() external returns (AbxSeedSource seedSource) {
        vm.startBroadcast();
        seedSource = AbxSeedSource(AbxLink.deploy(AbxSalts.SEED_SOURCE, AbxLink.initCode("AbxSeedSource"), "AbxSeedSource"));
        vm.stopBroadcast();

        console2.log("AbxSeedSource:", address(seedSource));
    }
}
