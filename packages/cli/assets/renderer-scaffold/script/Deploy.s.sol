// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {MyRenderer} from "../src/MyRenderer.sol";
import {MyTraits} from "../src/MyTraits.sol";

/// @notice Deploys the image + traits renderers and prints their addresses. Run with:
///   forge script script/Deploy.s.sol --rpc-url <your-rpc> --private-key <key> --broadcast
/// then wire them into your drop:
///   abx deploy-code --image-renderer <MyRenderer addr> --attributes-renderer <MyTraits addr> \
///        --onchain-uri --schema palette:HexColor:TokenOwner --name "..." --symbol ...
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        MyRenderer image = new MyRenderer();
        MyTraits traits = new MyTraits();
        vm.stopBroadcast();
        console2.log("MyRenderer (image)     :", address(image));
        console2.log("MyTraits  (attributes) :", address(traits));
        console2.log("Next: abx deploy-code --image-renderer <image> --attributes-renderer <traits> --onchain-uri --schema palette:HexColor:TokenOwner ...");
    }
}
