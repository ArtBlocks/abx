// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {EditionImageFactory} from "../src/factories/EditionImageFactory.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the canonical {EditionImageFactory} (which deploys the implementation). The
///         factory address is the trust root a platform allowlists for multi-work edition
///         drops. Creators then call `factory.deploy(...)` / `deployDeterministic(...)`. The
///         shared {AbxMetadataRenderer} and {AbxChunkStore} are reused (deployed by DeployRenderer).
contract DeployEdition is Script {
    function run() external returns (EditionImageFactory factory) {
        vm.startBroadcast();
        factory = EditionImageFactory(AbxLink.deploy(AbxSalts.EDITION_FACTORY, _initCode(), "EditionImageFactory"));
        vm.stopBroadcast();

        console2.log("EditionImageFactory:", address(factory));
        console2.log("implementation:     ", factory.implementation());
    }

    /// @notice Print the factory address without sending anything.
    function predict() external view {
        console2.log("EditionImageFactory", AbxLink.predict(AbxSalts.EDITION_FACTORY, _initCode()));
    }

    /// @dev This token type delegates part of its body into {AbxEditionLib} (EIP-170 relief), so the
    ///      factory's bytecode carries a link placeholder and MUST be linked post-compile against the
    ///      canonical library address — see {AbxLink}. `new EditionImageFactory{salt:}()` would make forge
    ///      auto-deploy {AbxEditionLib} at ITS OWN salt (zero) instead of {AbxSalts-EDITION_LIB},
    ///      putting a second, un-manifested copy of the library on chain and binding this factory to
    ///      it. Run {DeployLibraries} first.
    function _initCode() private view returns (bytes memory) {
        return AbxLink.initCode("EditionImageFactory", AbxLink.editionImageLibs());
    }
}
