// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @title DeployLibraries — CREATE2-deploy the delegatecalled write-path libraries, explicitly
/// @notice Run this FIRST on a new chain. The code-project deploys ({DeploySeriesCode},
///         {DeployEditionCode}) then link against exactly these addresses with no flags to pass —
///         they recompute them from the same salts. Idempotent: a library that already has code is
///         reported and skipped, so re-running is the normal way to verify a chain is set up.
///
///         `--sig 'predict()'` prints all three addresses without sending anything.
///
/// @dev **Why this script exists.** `forge` will auto-deploy an unlinked library when a script
///      references one, and it routes that through the keyless CREATE2 proxy, so the address is
///      already cross-chain-deterministic today. But that is the toolchain's behaviour, not this
///      repo's stated process — nothing in `script/` asked for CREATE2, and the addresses came from
///      forge's own salt rather than {AbxSalts}. That gap had a real cost: two token types were held
///      library-free, and an EIP-170 size floor was relaxed, on the recorded belief that linking a
///      library would make a factory's address non-deterministic. The broadcast artifacts refute it
///      (identical library addresses across chains from deployer nonces 215 apart; both
///      library-linked factories chain-identical across four deploy generations), but a belief that
///      wrong should not have been possible to hold. Making the deployment explicit is the fix:
///      determinism is now something this repo *does*, with salts it names, rather than something it
///      inherits and hopes for.
///
///      A library cannot be `new`ed from Solidity, so {AbxLink} reads each one's creation bytecode
///      from the compiled artifact and CREATE2s it through the proxy directly. See {AbxLink} for why
///      the linking is done post-compile rather than with `--libraries`, and for why there is no
///      compilation profile to remember.
contract DeployLibraries is Script {
    function run() external {
        vm.startBroadcast();
        AbxLink.deploy(AbxSalts.METADATA_LIB, AbxLink.initCode("AbxMetadataLib"), "AbxMetadataLib");
        address paramsLib = AbxLink.deploy(AbxSalts.PARAMS_LIB, AbxLink.initCode("AbxParamsLib"), "AbxParamsLib");
        AbxLink.deploy(AbxSalts.CODE_LIB, AbxLink.initCode("AbxCodeLib"), "AbxCodeLib");
        AbxLink.deploy(AbxSalts.EDITION_LIB, _editionLibCode(paramsLib), "AbxEditionLib");
        vm.stopBroadcast();
    }

    /// @notice Print the three canonical library addresses without sending anything.
    function predict() external view {
        console.log("AbxMetadataLib", AbxLink.predict(AbxSalts.METADATA_LIB, AbxLink.initCode("AbxMetadataLib")));
        address paramsLib = AbxLink.predict(AbxSalts.PARAMS_LIB, AbxLink.initCode("AbxParamsLib"));
        console.log("AbxParamsLib ", paramsLib);
        console.log("AbxCodeLib   ", AbxLink.predict(AbxSalts.CODE_LIB, AbxLink.initCode("AbxCodeLib")));
        console.log("AbxEditionLib", AbxLink.predict(AbxSalts.EDITION_LIB, _editionLibCode(paramsLib)));
    }

    /// @dev {AbxEditionLib} itself delegatecalls {AbxParamsLib}, so its bytecode — and therefore its
    ///      address — depends on where {AbxParamsLib} lands. That dependency is the whole reason this
    ///      script deploys in order rather than in a loop.
    function _editionLibCode(address paramsLib) private view returns (bytes memory) {
        AbxLink.Lib[] memory libs = new AbxLink.Lib[](1);
        libs[0] = AbxLink.Lib(AbxLink.PARAMS_FQN, paramsLib);
        return AbxLink.initCode("AbxEditionLib", libs);
    }
}
