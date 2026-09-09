// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MyConfigureHook, MyTransferHook, MyAugmentHook} from "../src/MyHooks.sol";

/// Deploy only the hook roles this project needs. TOKEN must already be deployed because every
/// write-time hook is pinned to its caller; this avoids a reusable hook accidentally trusting any
/// contract that knows its selector.
contract DeployHooks is Script {
    function run(address token, uint256 maxDataLength) external {
        vm.startBroadcast();
        MyConfigureHook configure = new MyConfigureHook(token, maxDataLength);
        MyTransferHook transfer = new MyTransferHook(token);
        MyAugmentHook augment = new MyAugmentHook(transfer);
        vm.stopBroadcast();
        console2.log("configure hook:", address(configure));
        console2.log("augment hook  :", address(augment));
        console2.log("transfer hook :", address(transfer));
        console2.log(
            "Next: abx set-param-hooks <token> --configure <configure> --augment <augment> --transfer <transfer>"
        );
    }
}
