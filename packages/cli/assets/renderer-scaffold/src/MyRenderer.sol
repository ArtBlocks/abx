// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LibString} from "solady/utils/LibString.sol";
import {IAbxFieldRenderer} from "abx-contracts/src/uri/IAbxFieldRenderer.sol";
import {IAbxParams} from "abx-contracts/src/extensions/params/IAbxParams.sol";

/// @title MyRenderer — a fully on-chain generative image, tinted by a collector PostParam
/// @notice FORK THIS. It renders the `image` field as an `image/svg+xml` document computed
///         entirely on-chain from:
///           • the per-token `seed` (mint-time randomness) → the geometry (ring count, weight,
///             rotation, hues), so every token is a distinct composition; and
///           • a `palette` (HexColor) PostParam a collector can set → the background tint, so
///             owners reshape their piece after minting (`abx configure-param <addr> <id> palette #ff3366`).
///
///         Wire it: deploy this contract, then
///           `abx deploy-code --image-renderer <this address> --attributes-renderer <MyTraits> \
///                 --onchain-uri --schema palette:HexColor:TokenOwner --name "..." --symbol ...`
///         (declare the `palette` schema, or the param is fixed at the default and collectors
///          can't set it.) Pair with MyTraits.sol so image AND traits read the SAME seed math.
///
///         Swap the geometry/palette math below for your own work. Keep the FIVE INVARIANTS in
///         IAbxFieldRenderer — above all, NEVER revert (a revert bricks the whole tokenURI).
contract MyRenderer is IAbxFieldRenderer {
    using LibString for uint256;

    /// @dev Wiring this renderer to a field it doesn't compute is a deploy-time miswiring — fail
    ///      loudly on THAT, but never on the field you DO render (invariant #3).
    error UnsupportedField();

    string private constant CONTENT_TYPE = "image/svg+xml";
    bytes32 private constant F_IMAGE = "image";
    bytes32 private constant SEED_KEY = "seed";
    bytes32 private constant PALETTE_KEY = "palette";
    string private constant DEFAULT_PALETTE = "#0e1a40";

    /// @inheritdoc IAbxFieldRenderer
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        if (field != F_IMAGE) revert UnsupportedField();

        // Invariant #1: the collection surface (contractURI) has no token — return a neutral
        // card, never a revert.
        if (tokenId == type(uint256).max) {
            return (CONTENT_TYPE, bytes(_svg(keccak256("collection"), DEFAULT_PALETTE)));
        }

        bytes32 seed = _seed(token, tokenId); // always renderable (falls back if unset)
        string memory palette = _palette(token, tokenId); // "#rrggbb", default if unset
        return (CONTENT_TYPE, bytes(_svg(seed, palette)));
    }

    // ── the work: seed → geometry, palette → tint (replace with your own) ─────────

    function _svg(bytes32 seed, string memory palette) private pure returns (string memory) {
        uint256 rings = 3 + (uint8(seed[0]) % 6); // 3..8 rings (MUST match MyTraits' math)
        uint256 weight = 1 + (uint8(seed[1]) % 3); // stroke 1..3
        uint256 rot = uint8(seed[2]) % 360; // whole-piece rotation
        uint256 baseHue = (uint256(uint8(seed[3])) * 360) / 256; // this token's colorway

        string memory circles;
        for (uint256 i = 1; i <= rings; ++i) {
            uint256 r = (46 * i) / rings;
            uint256 hue = (baseHue + i * 40) % 360;
            circles = string.concat(
                circles,
                '<circle cx="50" cy="50" r="',
                r.toString(),
                '" fill="none" stroke="hsl(',
                hue.toString(),
                ',72%,58%)" stroke-width="',
                weight.toString(),
                '" stroke-opacity="0.85"/>'
            );
        }

        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
            '<rect width="100" height="100" fill="',
            palette,
            '"/><g transform="rotate(',
            rot.toString(),
            ' 50 50)">',
            circles,
            '</g></svg>'
        );
    }

    // ── param reads (mirror these in your traits renderer for coherence) ──────────

    /// @dev The token's `seed`, or a deterministic fallback so the image is ALWAYS renderable
    ///      (pre-mint preview, or a project with no seed source). Never reverts.
    function _seed(address token, uint256 tokenId) private view returns (bytes32) {
        (bytes32 value, bool isHash) = _param(token, tokenId, SEED_KEY);
        if (uint256(value) != 0 && !isHash) return value;
        return keccak256(abi.encodePacked(token, tokenId));
    }

    /// @dev `palette` (HexColor) → "#rrggbb". Token scope wins over contract scope; a default
    ///      when unset. HexColor stores the RGB in the low 3 bytes of the param value.
    function _palette(address token, uint256 tokenId) private view returns (string memory) {
        (bytes32 value, bool isHash) = _param(token, tokenId, PALETTE_KEY);
        if (uint256(value) == 0 || isHash) return DEFAULT_PALETTE;
        return string.concat("#", LibString.toHexStringNoPrefix(uint256(value) & 0xffffff, 3));
    }

    /// @dev token-scope value, falling back to contract-scope (the tokenData merge rule). Returns
    ///      the value + whether it's a keccak commitment (a literal scalar param is NOT a hash).
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
