// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SeriesImageFactory} from "../src/factories/SeriesImageFactory.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the canonical {SeriesImageFactory} (which deploys the implementation). The
///         factory address is the trust root a platform allowlists for multi-token Series drops.
///         Creators then call `factory.deploy(...)` / `deployDeterministic(...)`. The shared
///         {AbxMetadataRenderer} and {AbxChunkStore} are reused (deployed by DeployRenderer).
contract DeploySeries is Script {
    /// @dev Idempotent, via {AbxLink-deploy}: the keyless CREATE2 proxy REVERTS on an occupied
    ///      address, so a bare `new X{salt}()` turns "this chain is already set up" into an opaque
    ///      failure. Re-running is the normal way to finish a partial bootstrap, and during the
    ///      2026-08-13 deploy two scripts did exactly this — the chunk store aborted on both chains
    ///      because its bytecode was unchanged and the address was already occupied.
    function run() external returns (SeriesImageFactory factory) {
        vm.startBroadcast();
        factory = SeriesImageFactory(AbxLink.deploy(AbxSalts.SERIES_FACTORY, _initCode(), "SeriesImageFactory"));
        vm.stopBroadcast();

        console2.log("SeriesImageFactory:", address(factory));
        console2.log("implementation:    ", factory.implementation());
    }

    /// @notice Print the factory address without sending anything.
    function predict() external view {
        console2.log("SeriesImageFactory", AbxLink.predict(AbxSalts.SERIES_FACTORY, _initCode()));
    }

    /// @dev Library-linked since the metadata field store was externalized — every token type links
    ///      {AbxMetadataLib}, so even the plainest 721 factory now carries a link placeholder and
    ///      must be linked post-compile. See {AbxLink}.
    function _initCode() private view returns (bytes memory) {
        return AbxLink.initCode("SeriesImageFactory", AbxLink.imageLibs());
    }
}
