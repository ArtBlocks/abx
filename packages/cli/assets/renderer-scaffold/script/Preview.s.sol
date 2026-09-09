// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IAbxFieldRenderer} from "abx-contracts/src/uri/IAbxFieldRenderer.sol";
import {MyRenderer} from "../src/MyRenderer.sol";
import {MyTraits} from "../src/MyTraits.sol";
import {MockParams} from "../test/MyRenderer.t.sol";

/// @notice A human-inspection harness, not a test. `forge test` is what proves render() behaves
///         (never reverts, traits agree with the image, etc) — this script exists ONLY because
///         assertions don't let a person actually LOOK at the SVG/JSON a renderer produces. It
///         calls the exact same `IAbxFieldRenderer.render(token, tokenId, field)` interface the
///         deployed ABX token calls at read time, against a `MockParams` standing in for the
///         token (the same stand-in `test/MyRenderer.t.sol` uses), and writes the raw output to
///         disk so it can be opened in a browser or editor.
///
///         GAS DISCLAIMER — read before trusting any number this script prints: a local
///         `forge script` run executes against an in-memory EVM with no real chain's calldata
///         pricing, contract-size/warm-storage state, or congestion. The gas this script reports
///         (and even a real `--broadcast` dry run) is NOT a production gas measurement. If you
///         need real numbers, deploy with `script/Deploy.s.sol` and read `tokenURI` on the actual
///         chain you're targeting.
///
/// Usage (from this scaffold's directory, after `forge soldeer install`):
///   forge script script/Preview.s.sol
/// Every input has a representative default and is overridable via env vars, so you can preview
/// a specific token without editing this file:
///   PREVIEW_TOKEN_ID=42 PREVIEW_SEED=0x00112233445566778899aabbccddeeff00112233445566778899aabbccddee \
///   PREVIEW_PALETTE=0xff3366 forge script script/Preview.s.sol
/// Set PREVIEW_TOKEN_ID to `115792089237316195423570985008687907853269984665640564039457584007913129639935`
/// (type(uint256).max) to preview the collection surface (contractURI) instead of a token.
/// Output lands in `preview-out/` at the repo root of this scaffold — open `preview-out/image.svg`
/// in a browser, `preview-out/attributes.json` in an editor.
contract Preview is Script {
    function run() external {
        uint256 tokenId = vm.envOr("PREVIEW_TOKEN_ID", uint256(7));
        bytes32 seed = vm.envOr("PREVIEW_SEED", bytes32(uint256(0x1234)));
        // `palette` is a HexColor PostParam: the RGB value packed into the low 3 bytes.
        bytes32 palette = vm.envOr("PREVIEW_PALETTE", bytes32(uint256(0xff3366)));

        // vm.writeFileBinary does not create parent directories; make sure ours exists.
        vm.createDir("preview-out", true);

        MyRenderer image = new MyRenderer();
        MyTraits traits = new MyTraits();
        MockParams params = new MockParams();
        params.setToken(tokenId, "seed", seed);
        params.setToken(tokenId, "palette", palette);

        console2.log("== NOT a gas measurement (see script comment) ==");
        console2.log("== preview inputs ==");
        console2.log("tokenId:", tokenId);
        console2.log("seed   :", vm.toString(seed));
        console2.log("palette:", vm.toString(palette));

        _renderAndDump(image, address(params), tokenId, "image", "image", "preview-out/image");
        _renderAndDump(traits, address(params), tokenId, "attributes", "attributes", "preview-out/attributes");
    }

    /// @dev Runs the ACTUAL renderer interface — the same call the resolver/on-chain metadata
    ///      renderer makes — and surfaces a revert instead of swallowing it, so a miswired field
    ///      or a broken invariant shows up here instead of silently bricking `tokenURI` later.
    function _renderAndDump(
        IAbxFieldRenderer renderer,
        address token,
        uint256 tokenId,
        bytes32 field,
        string memory fieldLabel,
        string memory pathNoExt
    ) private {
        console2.log(string.concat("== field: ", fieldLabel, " =="));
        try renderer.render(token, tokenId, field) returns (string memory contentType, bytes memory data) {
            string memory path = string.concat(pathNoExt, ".", _extFor(contentType));
            vm.writeFileBinary(path, data);
            console2.log("contentType:", contentType);
            console2.log("bytes      :", data.length);
            console2.log("written to :", path);
        } catch Error(string memory reason) {
            console2.log("REVERTED:", reason);
        } catch Panic(uint256 code) {
            console2.log("REVERTED, panic code:", code);
        } catch (bytes memory lowLevelData) {
            // A custom error (e.g. MyRenderer.UnsupportedField) has no ABI-decoded reason string —
            // this is the raw revert data, selector first, so you can tell which error fired.
            console2.log("REVERTED, raw data:", vm.toString(lowLevelData));
        }
    }

    /// @dev Extension purely for local viewing convenience — not part of the on-chain contract.
    function _extFor(string memory contentType) private pure returns (string memory) {
        bytes32 ct = keccak256(bytes(contentType));
        if (ct == keccak256("image/svg+xml")) return "svg";
        if (ct == keccak256("application/json")) return "json";
        if (ct == keccak256("text/html")) return "html";
        if (ct == keccak256("text/plain")) return "txt";
        return "bin";
    }
}
