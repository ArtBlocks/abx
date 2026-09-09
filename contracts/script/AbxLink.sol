// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {LibString} from "solady/utils/LibString.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @title AbxLink — post-compile library linking + explicit CREATE2, shared by the deploy scripts
/// @notice The one place that decides how an ABX artifact becomes initcode. Every script that touches
///         a library-linked contract goes through here, so the forge lane and the SDK lane cannot
///         drift apart on an address.
///
/// @dev **Why post-compile linking, and not `--libraries`.**
///
///      A contract that delegatecalls an external library compiles with a `__$<hash>$__` placeholder
///      where the library address goes. There are two ways to fill it, and they do not produce the
///      same bytecode:
///
///      1. `--libraries` (compile-time). solc writes the address map into `settings.libraries`, which
///         is part of the metadata JSON, whose hash is appended to the bytecode. So it changes the
///         initcode — and therefore the CREATE2 address — of the very contracts it is meant to pin.
///         Measured: passing `--libraries` moves all four of the addresses below.
///      2. Substituting the placeholder bytes in the compiled artifact (what this library does).
///         Nothing but the placeholder changes, so the initcode stays a pure function of the default
///         artifact plus the addresses chosen — which is exactly what `sync-abis` ships to the SDK.
///
///      The SDK can only do (2): it ships bytecode, it does not compile. So (2) is the canonical
///      method, and this library exists so the forge lane uses it too. The acceptance test is direct
///      and worth re-running whenever this changes: every `predict()` here must equal the SDK's
///      matching `predict*()` helper in `packages/sdk/src/create2.ts`, byte for byte.
///
///      Letting forge auto-deploy instead would be worse than either: the libraries land at forge's
///      own salt rather than {AbxSalts}, so the factory would link against libraries the deployment
///      manifest does not record.
///
///      **There is no profile to remember.** `foundry.toml` pins the code contracts to
///      `optimizer_runs = 200` via `compilation_restrictions`, which apply under every profile, so the
///      default-profile artifact these functions read is already the canonical one. An earlier version
///      of the redeploy checklist told operators to set `FOUNDRY_PROFILE=clone-impl`; that is a no-op
///      (`additional_compiler_profiles` is not selectable that way) and it is gone.
library AbxLink {
    /// @dev Arachnid's keyless deterministic-deployment proxy, present on every EVM chain.
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    string internal constant PARAMS_FQN = "src/libraries/AbxParamsLib.sol:AbxParamsLib";
    string internal constant CODE_FQN = "src/libraries/AbxCodeLib.sol:AbxCodeLib";
    string internal constant EDITION_FQN = "src/libraries/AbxEditionLib.sol:AbxEditionLib";
    string internal constant METADATA_FQN = "src/libraries/AbxMetadataLib.sol:AbxMetadataLib";

    VmSafe private constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev One library's fully-qualified name and the address to link it at.
    struct Lib {
        string fqn;
        address at;
    }

    /// @notice A contract's creation bytecode with every library placeholder substituted.
    /// @dev Reads the artifact JSON as a *string* rather than via `vm.getCode`, because `vm.getCode`
    ///      refuses an unlinked artifact outright — there is nothing to get until we link it.
    ///      Reverts if any placeholder survives, so a newly-introduced library dependency fails the
    ///      deploy loudly instead of deploying a contract that reverts on its first delegatecall.
    function initCode(string memory artifact, Lib[] memory libs) internal view returns (bytes memory) {
        string memory hexCode =
            vm.parseJsonString(vm.readFile(string.concat("out/", artifact, ".sol/", artifact, ".json")), ".bytecode.object");

        for (uint256 i; i < libs.length; ++i) {
            hexCode = LibString.replace(
                hexCode, placeholder(libs[i].fqn), LibString.toHexStringNoPrefix(uint256(uint160(libs[i].at)), 20)
            );
        }

        require(!LibString.contains(hexCode, "__$"), string.concat("unlinked library placeholder in ", artifact));
        return vm.parseBytes(hexCode);
    }

    /// @notice A contract's creation bytecode, when it links no libraries.
    function initCode(string memory artifact) internal view returns (bytes memory) {
        return initCode(artifact, new Lib[](0));
    }

    /// @dev solc's placeholder for a library: `__$` + the first 34 hex chars of `keccak256(fqn)` + `$__`.
    function placeholder(string memory fqn) internal pure returns (string memory) {
        return string.concat(
            "__$", LibString.slice(LibString.toHexStringNoPrefix(uint256(keccak256(bytes(fqn))), 32), 0, 34), "$__"
        );
    }

    /// @notice The canonical address of each write-path library, recomputed from its salt and its
    ///         compiled bytecode — never passed in, so a factory deploy cannot link against a library
    ///         the deployment manifest does not record.
    /// @dev These are the same values {DeployLibraries} prints. Recomputing rather than accepting a
    ///      flag is the point: there is no way to deploy a factory against the wrong libraries by
    ///      typo, and no `--libraries` invocation to get wrong (which would move the address anyway).
    function paramsLib() internal view returns (address) {
        return predict(AbxSalts.PARAMS_LIB, initCode("AbxParamsLib"));
    }

    function codeLib() internal view returns (address) {
        return predict(AbxSalts.CODE_LIB, initCode("AbxCodeLib"));
    }

    function metadataLib() internal view returns (address) {
        return predict(AbxSalts.METADATA_LIB, initCode("AbxMetadataLib"));
    }

    function editionLib() internal view returns (address) {
        Lib[] memory libs = new Lib[](1);
        libs[0] = Lib(PARAMS_FQN, paramsLib());
        return predict(AbxSalts.EDITION_LIB, initCode("AbxEditionLib", libs));
    }

    /// @notice Every ERC-721 image factory's set — {AbxMetadataLib} alone. These two used to link
    ///         nothing; externalizing the metadata field store made every token type library-linked.
    function imageLibs() internal view returns (Lib[] memory libs) {
        libs = new Lib[](1);
        libs[0] = Lib(METADATA_FQN, metadataLib());
    }

    /// @notice The libraries a {SeriesCode} project's factory links.
    function seriesCodeLibs() internal view returns (Lib[] memory libs) {
        libs = new Lib[](3);
        libs[0] = Lib(PARAMS_FQN, paramsLib());
        libs[1] = Lib(CODE_FQN, codeLib());
        libs[2] = Lib(METADATA_FQN, metadataLib());
    }

    /// @notice The libraries an ERC-1155 image/1-of-1 edition factory links.
    function editionImageLibs() internal view returns (Lib[] memory libs) {
        libs = new Lib[](2);
        libs[0] = Lib(EDITION_FQN, editionLib());
        libs[1] = Lib(METADATA_FQN, metadataLib());
    }

    /// @notice The libraries an {EditionCode} project's factory links.
    function editionCodeLibs() internal view returns (Lib[] memory libs) {
        libs = new Lib[](4);
        libs[0] = Lib(PARAMS_FQN, paramsLib());
        libs[1] = Lib(CODE_FQN, codeLib());
        libs[2] = Lib(EDITION_FQN, editionLib());
        libs[3] = Lib(METADATA_FQN, metadataLib());
    }

    /// @notice The address the keyless proxy will produce for `salt` + `code`.
    function predict(bytes32 salt, bytes memory code) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_PROXY, salt, keccak256(code)))))
        );
    }

    /// @notice CREATE2 `code` at `salt` through the keyless proxy, or report an existing deployment.
    /// @dev Idempotent by necessity, not just convenience: the proxy *reverts* on an occupied address,
    ///      so re-running a chain's setup would fail without this check.
    function deploy(bytes32 salt, bytes memory code, string memory label) internal returns (address at) {
        at = predict(salt, code);
        if (at.code.length != 0) {
            console.log("already deployed", label, at);
            return at;
        }
        // Say WHICH thing is missing. Without this, a chain that has no keyless proxy fails the
        // address check below instead — reporting "predicted address mismatch", the one message
        // guaranteed to send the reader hunting for a linking or salt bug that isn't there.
        require(
            CREATE2_PROXY.code.length != 0,
            "no keyless CREATE2 proxy on this chain (0x4e59b448...) - deploy it first"
        );
        (bool ok, bytes memory ret) = CREATE2_PROXY.call(abi.encodePacked(salt, code));
        require(ok, string.concat("CREATE2 deploy failed: ", label));
        require(address(uint160(bytes20(ret))) == at, string.concat("predicted address mismatch: ", label));
        // The proxy returns an address even when the constructor reverted in some edge cases, so
        // confirm code actually landed rather than trusting the return value.
        require(at.code.length != 0, string.concat("deployed but no code at target: ", label));
        console.log("deployed", label, at);
    }
}
