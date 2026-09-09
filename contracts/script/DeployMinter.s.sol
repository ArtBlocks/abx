// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AbxFixedPriceMinter} from "../src/minters/AbxFixedPriceMinter.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the canonical {AbxFixedPriceMinter} — a single, ownerless, multi-tenant
///         singleton shared by every project on the chain (like the renderer / chunk store, a
///         public good). A project owner assigns it on their token (`setMinter`) and configures a
///         sale on it (`configure`); it sells any token exposing {IAbxSequentialMint}. Record the
///         printed address in the SDK deployments manifest under `fixedPriceMinter`.
contract DeployMinter is Script {
    /// @dev Idempotent, via {AbxLink-deploy}: the keyless CREATE2 proxy REVERTS on an occupied
    ///      address, so a bare `new X{salt}()` turns "this chain is already set up" into an opaque
    ///      failure. Re-running is the normal way to finish a partial bootstrap, and during the
    ///      2026-08-13 deploy two scripts did exactly this — the chunk store aborted on both chains
    ///      because its bytecode was unchanged and the address was already occupied.
    function run() external returns (AbxFixedPriceMinter minter) {
        vm.startBroadcast();
        minter = AbxFixedPriceMinter(AbxLink.deploy(AbxSalts.FIXED_PRICE_MINTER, AbxLink.initCode("AbxFixedPriceMinter"), "AbxFixedPriceMinter"));
        vm.stopBroadcast();

        console2.log("AbxFixedPriceMinter:", address(minter));
    }
}
