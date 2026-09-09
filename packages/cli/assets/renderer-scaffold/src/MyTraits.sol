// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LibString} from "solady/utils/LibString.sol";
import {IAbxFieldRenderer} from "abx-contracts/src/uri/IAbxFieldRenderer.sol";
import {IAbxParams} from "abx-contracts/src/extensions/params/IAbxParams.sol";

/// @title MyTraits — on-chain marketplace traits, coherent with MyRenderer
/// @notice FORK THIS. Renders the `attributes` field as an `application/json` array a marketplace
///         reads. Wire with `abx deploy-code --attributes-renderer <this address> --onchain-uri`.
///
///         COHERENCE RULE: read the SAME seed bytes the SAME way as your image renderer, so a
///         trait can never disagree with what's drawn (here `Rings` = `3 + seed[0] % 6`, byte-
///         identical to MyRenderer). Derive traits from the seed with integer/threshold math so
///         they're exactly reproducible on-chain (a raw float or `Math.random` would not be).
contract MyTraits is IAbxFieldRenderer {
    using LibString for uint256;

    error UnsupportedField();

    string private constant CONTENT_TYPE = "application/json";
    bytes32 private constant F_ATTRIBUTES = "attributes";
    bytes32 private constant SEED_KEY = "seed";
    bytes32 private constant PALETTE_KEY = "palette";

    /// @inheritdoc IAbxFieldRenderer
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        if (field != F_ATTRIBUTES) revert UnsupportedField();

        // Invariant #1: the collection surface has no per-token traits — an empty array, not a revert.
        if (tokenId == type(uint256).max) return (CONTENT_TYPE, bytes("[]"));

        bytes32 seed = _seed(token, tokenId);
        uint256 rings = 3 + (uint8(seed[0]) % 6); // SAME math as MyRenderer._svg
        (bytes32 pal, bool palIsHash) = _param(token, tokenId, PALETTE_KEY);
        bool paletteSet = uint256(pal) != 0 && !palIsHash;

        string memory json = string.concat(
            "[",
            _trait("Rings", rings.toString()),
            ",",
            _trait("Palette", paletteSet ? "Custom" : "Default"),
            "]"
        );
        return (CONTENT_TYPE, bytes(json));
    }

    function _trait(string memory k, string memory v) private pure returns (string memory) {
        return string.concat(
            '{"trait_type":"', LibString.escapeJSON(k), '","value":"', LibString.escapeJSON(v), '"}'
        );
    }

    function _seed(address token, uint256 tokenId) private view returns (bytes32) {
        (bytes32 value, bool isHash) = _param(token, tokenId, SEED_KEY);
        if (uint256(value) != 0 && !isHash) return value;
        return keccak256(abi.encodePacked(token, tokenId));
    }

    function _param(address token, uint256 tokenId, bytes32 key)
        private
        view
        returns (bytes32 value, bool valueIsHash)
    {
        bool isSet;
        (value, valueIsHash, isSet) = IAbxParams(token).tokenParam(tokenId, key);
        if (isSet) return (value, valueIsHash);
        (value, valueIsHash,) = IAbxParams(token).contractParam(key);
        return (value, valueIsHash);
    }
}
