// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OneOfOneEditionFactory} from "../src/factories/OneOfOneEditionFactory.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the canonical {OneOfOneEditionFactory} (which deploys the implementation). The
///         factory address is the trust root a platform allowlists for 1/1 edition drops.
///         Creators then call `factory.deploy(...)` / `deployDeterministic(...)`.
contract DeployOneOfOneEdition is Script {
    function run() external returns (OneOfOneEditionFactory factory) {
        vm.startBroadcast();
        factory = OneOfOneEditionFactory(AbxLink.deploy(AbxSalts.ONE_OF_ONE_EDITION_FACTORY, _initCode(), "OneOfOneEditionFactory"));
        vm.stopBroadcast();

        console2.log("OneOfOneEditionFactory:", address(factory));
        console2.log("implementation:        ", factory.implementation());
    }

    /// @notice Print the factory address without sending anything.
    function predict() external view {
        console2.log("OneOfOneEditionFactory", AbxLink.predict(AbxSalts.ONE_OF_ONE_EDITION_FACTORY, _initCode()));
    }

    /// @dev This token type delegates part of its body into {AbxEditionLib} (EIP-170 relief), so the
    ///      factory's bytecode carries a link placeholder and MUST be linked post-compile against the
    ///      canonical library address — see {AbxLink}. `new OneOfOneEditionFactory{salt:}()` would make forge
    ///      auto-deploy {AbxEditionLib} at ITS OWN salt (zero) instead of {AbxSalts-EDITION_LIB},
    ///      putting a second, un-manifested copy of the library on chain and binding this factory to
    ///      it. Run {DeployLibraries} first.
    function _initCode() private view returns (bytes memory) {
        return AbxLink.initCode("OneOfOneEditionFactory", AbxLink.editionImageLibs());
    }
}
