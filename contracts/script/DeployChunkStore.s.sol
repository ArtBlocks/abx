// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AbxChunkStore} from "../src/renderers/AbxChunkStore.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the canonical {AbxChunkStore} — the shared, ownerless SSTORE2 multi-chunk
///         content store + reader every `reader`-represented field points at. One deployment
///         serves every ABX token on the chain. CREATE2 via {AbxSalts}, so the address is
///         identical on every chain. (The CLI's `ensureChunkStore` can also deploy it lazily on a
///         chain with no manifest entry, but the canonical set is deployed with this script.)
contract DeployChunkStore is Script {
    /// @dev Idempotent, via {AbxLink-deploy}: the keyless CREATE2 proxy REVERTS on an occupied
    ///      address, so a bare `new X{salt}()` turns "this chain is already set up" into an opaque
    ///      failure. Re-running is the normal way to finish a partial bootstrap, and during the
    ///      2026-08-13 deploy two scripts did exactly this — the chunk store aborted on both chains
    ///      because its bytecode was unchanged and the address was already occupied.
    function run() external returns (AbxChunkStore store) {
        vm.startBroadcast();
        store = AbxChunkStore(AbxLink.deploy(AbxSalts.CHUNK_STORE, AbxLink.initCode("AbxChunkStore"), "AbxChunkStore"));
        vm.stopBroadcast();

        console2.log("AbxChunkStore:", address(store));
    }
}
