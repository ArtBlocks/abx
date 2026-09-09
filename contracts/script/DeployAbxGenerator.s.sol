// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";
import {AbxGenerator} from "../src/renderers/AbxGenerator.sol";
import {AbxLink} from "./AbxLink.sol";
import {AbxSalts} from "./AbxSalts.sol";

/// @notice Deploys the canonical {AbxGenerator} — the per-chain on-chain generator singleton
///         (the `animation` field renderer serving both code-custody modes). The runtime
///         rides with it: `abx.js` and `gunzipScripts-0.0.1.js` are SSTORE2-written from
///         `assets/` in the same run (their pointers are constructor-baked immutables), and
///         the generator itself lands at a deterministic-salt CREATE2 address (via the
///         canonical CREATE2 deployer forge broadcasts through).
///
///         Registry wiring per chain (specs/protocol/dependency-registry.md):
///         mainnet + Sepolia = Art Blocks' DependencyRegistryV0; anywhere else, set
///         `ABX_DEPENDENCY_REGISTRY` (or accept zero = no default registry — collections can
///         still point at their own).
///
///         Gateways are overridable per run: `ABX_IPFS_GATEWAY` / `ABX_ARWEAVE_GATEWAY`
///         (full URL prefixes — the code root is appended verbatim). Collections override
///         at read time with the collection's `abx_gateway_ipfs` / `abx_gateway_arweave` field.
contract DeployAbxGenerator is Script {
    /// @dev The deterministic-salt convention: one well-known salt per canonical singleton
    ///      (registry: {AbxSalts}). NOTE: the generator alone is NOT cross-chain-identical — its
    ///      constructor bakes chain-specific immutables (asset pointers + dependency registry), so
    ///      the salt fixes intent, not the resulting address, which differs per chain.
    bytes32 internal constant SALT = AbxSalts.GENERATOR;

    address internal constant AB_DEPENDENCY_REGISTRY_MAINNET =
        0x37861f95882ACDba2cCD84F5bFc4598e2ECDDdAF;
    address internal constant AB_DEPENDENCY_REGISTRY_SEPOLIA =
        0x5Fcc415BCFb164C5F826B5305274749BeB684e9b;

    function run() external returns (AbxGenerator generator) {
        string memory abxJs = vm.readFile("assets/abx.js");
        string memory gunzipScript = vm.readFile("assets/gunzipScripts-0.0.1.js");
        address registry = _registryForChain();
        string memory ipfsGateway = vm.envOr("ABX_IPFS_GATEWAY", string("https://ipfs.io/ipfs/"));
        string memory arweaveGateway =
            vm.envOr("ABX_ARWEAVE_GATEWAY", string("https://arweave.net/"));

        // Reuse pinned asset pointers when given. THIS SCRIPT CANNOT BE IDEMPOTENT BY ADDRESS
        // ALONE, and that is worth understanding before re-running it: `SSTORE2.write` is a plain
        // `CREATE`, so fresh pointers land at nonce-dependent addresses; the pointers are
        // constructor args; the args are part of the initcode; so the CREATE2 address moves. A
        // re-run without pinned pointers therefore deploys a SECOND generator at a new address and
        // succeeds quietly — the one failure mode worse than aborting, since the manifest keeps
        // naming the first one while the operator watches a green run.
        //
        // Pass ABX_ABX_JS_POINTER + ABX_GUNZIP_POINTER (both printed below) to reproduce an existing
        // generator exactly, at which point the existence check makes the re-run a no-op.
        address abxJsPointer = vm.envOr("ABX_ABX_JS_POINTER", address(0));
        address gunzipPointer = vm.envOr("ABX_GUNZIP_POINTER", address(0));
        bool pinned = abxJsPointer != address(0) && gunzipPointer != address(0);

        if (pinned) {
            address predicted = _predictGenerator(
                registry, abxJsPointer, gunzipPointer, ipfsGateway, arweaveGateway
            );
            if (predicted.code.length != 0) {
                console2.log("already deployed AbxGenerator", predicted);
                return AbxGenerator(predicted);
            }
        } else {
            console2.log("!! no pinned asset pointers - writing NEW ones, so this deploys a NEW");
            console2.log("!! generator even if one already exists. Pin with ABX_ABX_JS_POINTER +");
            console2.log("!! ABX_GUNZIP_POINTER (printed below) to make a re-run a no-op.");
        }

        vm.startBroadcast();
        if (!pinned) {
            abxJsPointer = SSTORE2.write(bytes(abxJs));
            gunzipPointer = SSTORE2.write(bytes(gunzipScript));
        }
        generator = new AbxGenerator{salt: SALT}(
            registry, abxJsPointer, gunzipPointer, ipfsGateway, arweaveGateway
        );
        vm.stopBroadcast();

        console2.log("AbxGenerator:              ", address(generator));
        console2.log("defaultDependencyRegistry: ", registry);
        console2.log("abxJsPointer:              ", abxJsPointer);
        console2.log("gunzipScriptPointer:       ", gunzipPointer);
        console2.log("defaultIpfsGateway:        ", ipfsGateway);
        console2.log("defaultArweaveGateway:     ", arweaveGateway);
    }

    /// @dev The address `new AbxGenerator{salt: SALT}(...)` will produce for these constructor
    ///      args — the args are appended to the creation bytecode, so they are part of what CREATE2
    ///      hashes. Mirrors forge's own derivation for a salted `new`.
    function _predictGenerator(
        address registry,
        address abxJsPointer,
        address gunzipPointer,
        string memory ipfsGateway,
        string memory arweaveGateway
    ) internal pure returns (address) {
        bytes memory initCode = abi.encodePacked(
            type(AbxGenerator).creationCode,
            abi.encode(registry, abxJsPointer, gunzipPointer, ipfsGateway, arweaveGateway)
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), AbxLink.CREATE2_PROXY, SALT, keccak256(initCode)
                        )
                    )
                )
            )
        );
    }

    /// @dev AB's registry on the chains it exists on; elsewhere the env override (zero = no
    ///      default — honest, not a guess: an unresolvable ref degrades to a comment marker).
    function _registryForChain() internal view returns (address) {
        if (block.chainid == 1) return AB_DEPENDENCY_REGISTRY_MAINNET;
        if (block.chainid == 11155111) return AB_DEPENDENCY_REGISTRY_SEPOLIA;
        return vm.envOr("ABX_DEPENDENCY_REGISTRY", address(0));
    }
}
