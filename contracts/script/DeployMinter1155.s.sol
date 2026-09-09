// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AbxFixedPriceMinter1155} from "../src/minters/AbxFixedPriceMinter1155.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the canonical {AbxFixedPriceMinter1155} — a single, ownerless, multi-tenant
///         singleton shared by every edition project on the chain (like the 721
///         {AbxFixedPriceMinter}, a public good). A project owner assigns it on their token
///         (`setMinter`) and configures a sale per `(token, id)` on it (`configure`); it sells
///         any token exposing {IAbxEditionMint}. Record the printed address in the SDK
///         deployments manifest under `fixedPriceMinter1155`.
contract DeployMinter1155 is Script {
    /// @dev Idempotent, via {AbxLink-deploy}: the keyless CREATE2 proxy REVERTS on an occupied
    ///      address, so a bare `new X{salt}()` turns "this chain is already set up" into an opaque
    ///      failure. Re-running is the normal way to finish a partial bootstrap, and during the
    ///      2026-08-13 deploy two scripts did exactly this — the chunk store aborted on both chains
    ///      because its bytecode was unchanged and the address was already occupied.
    function run() external returns (AbxFixedPriceMinter1155 minter) {
        vm.startBroadcast();
        minter = AbxFixedPriceMinter1155(AbxLink.deploy(AbxSalts.FIXED_PRICE_MINTER_1155, AbxLink.initCode("AbxFixedPriceMinter1155"), "AbxFixedPriceMinter1155"));
        vm.stopBroadcast();

        console2.log("AbxFixedPriceMinter1155:", address(minter));
    }
}
