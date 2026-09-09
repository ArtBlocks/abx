// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {LibString} from "solady/utils/LibString.sol";

import {IAbxFieldRenderer} from "../../uri/IAbxFieldRenderer.sol";
import {IAbxParams} from "../../extensions/params/IAbxParams.sol";
import {
    IAbxConfigurableParams
} from "../../extensions/configurable-params/IAbxConfigurableParams.sol";
import {TokenDataLib} from "../../libraries/TokenDataLib.sol";

/// @title SeedSvgRenderer — WORKED EXAMPLE: a generative SVG computed entirely on-chain
/// @notice **Fork freely.** Not a canonical contract — the image half of a fully in-chain drop:
///         an `image` field renderer that returns a complete `image/svg+xml` document derived
///         from the per-token `seed` param + a `palette` (HexColor) PostParam. Paired with the
///         {SeedTraitsRenderer} attributes example, a project wiring BOTH (via `--image-renderer`
///         and `--attributes-renderer`) + `--onchain-uri` resolves its whole `tokenURI` — name,
///         image, traits — from chain, with **zero** dependency on anything outside the EVM: no
///         browser, no bucket, no resolver, no effect runner. The canonical {AbxMetadataRenderer}
///         staticcalls this, wraps the bytes as `data:image/svg+xml;base64,…`, and embeds them.
///
///         Wire it by setting the collection-scope `image` field to the `renderer` representation
///         with `value = abi.encode(address(this))` — one deployment then draws every token.
///
///         Techniques on display (swap the geometry/palette math for your project's):
///         - **seed → geometry** — the ring count, stroke weight, and a rotation all read
///           independent `seed` bytes, so each token is a distinct composition;
///         - **palette PostParam tints the piece** — `palette` (HexColor) is read token-scope
///           with a contract-scope fallback (the tokenData merge rule, token wins) and used as
///           the field tint; per-ring hues are derived from seed bytes so the palette reads as
///           an accent over deterministic structure — collectors reconfiguring `palette`
///           re-address the render (a new still) without touching the seed-set form;
///         - **never reverts, always renderable** — no seed (pre-mint preview, or a project
///           without a seed source) falls back to `keccak(tokenId)`, and the collection surface
///           (`tokenId == type(uint256).max`, per {IAbxFieldRenderer}) returns a neutral card;
///         - **integer-only SVG** — a `0 0 100 100` viewBox with integer coordinates keeps the
///           document small (a few hundred bytes) — the reason an on-chain `tokenURI` is a
///           genuinely good fit here, unlike a 200KB JS bundle.
/// @dev Stateless and view-only, like every field renderer: same chain state → same bytes.
contract SeedSvgRenderer is IAbxFieldRenderer {
    using LibString for uint256;

    /// @notice This renderer computes exactly one field; wiring it to any other is a
    ///         deploy-time misconfiguration, surfaced loudly rather than served quietly.
    error UnsupportedField();

    string private constant CONTENT_TYPE = "image/svg+xml";

    bytes32 private constant F_IMAGE = "image";
    bytes32 private constant SEED_KEY = "seed";
    bytes32 private constant PALETTE_KEY = "palette";

    uint256 private constant RINGS_MIN = 3;
    uint256 private constant RINGS_SPAN = 6; // 3..8 rings

    /// @inheritdoc IAbxFieldRenderer
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        if (field != F_IMAGE) revert UnsupportedField();

        // collection surface (e.g. contractURI): no token → a neutral card, never a revert.
        if (tokenId == type(uint256).max) {
            return (CONTENT_TYPE, bytes(_card("#0e1a40", "ABX")));
        }

        bytes32 seed = _seed(token, tokenId);
        string memory palette = _palette(token, tokenId); // "#rrggbb", default if unset
        return (CONTENT_TYPE, bytes(_art(seed, palette)));
    }

    // ── the composition ──────────────────────────────────────────────────────

    /// @dev The generative document: concentric rings whose count/weight/rotation come from the
    ///      seed, tinted by the palette. Integer coordinates over a 0..100 viewBox.
    function _art(bytes32 seed, string memory palette) private pure returns (string memory) {
        uint256 rings = RINGS_MIN + (uint8(seed[0]) % RINGS_SPAN);
        uint256 weight = 1 + (uint8(seed[1]) % 3); // 1..3
        uint256 rot = uint8(seed[2]) % 360;
        uint256 baseHue = (uint256(uint8(seed[3])) * 360) / 256; // token's colorway
        uint256 hueStep = 20 + (uint8(seed[4]) % 60); // 20..79° between rings

        string memory circles;
        for (uint256 i = 1; i <= rings; ++i) {
            uint256 r = (46 * i) / rings; // spread rings across the field
            // Vivid HSL: fixed saturation/lightness so rings always POP over any palette bg;
            // hue steps per ring for a colorway that reads as generative, not muddy.
            uint256 hue = (baseHue + i * hueStep) % 360;
            circles = string.concat(
                circles,
                '<circle cx="50" cy="50" r="',
                r.toString(),
                '" fill="none" stroke="',
                _hsl(hue),
                '" stroke-width="',
                weight.toString(),
                '" stroke-opacity="0.85"/>'
            );
        }

        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
            '<rect width="100" height="100" fill="',
            palette,
            '"/>',
            '<g transform="rotate(',
            rot.toString(),
            ' 50 50)">',
            circles,
            '</g>',
            '<circle cx="50" cy="50" r="2" fill="',
            palette,
            '" stroke="#fff" stroke-width="1"/>',
            '</svg>'
        );
    }

    /// @dev A neutral collection card (contractURI surface): the palette field + a label.
    function _card(string memory bg, string memory label) private pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
            '<rect width="100" height="100" fill="',
            bg,
            '"/>',
            '<text x="50" y="54" fill="#fff" font-family="monospace" font-size="10"',
            ' text-anchor="middle">',
            LibString.escapeHTML(label),
            '</text></svg>'
        );
    }

    /// @dev `hsl(H,72%,58%)` — a vivid, SVG-legal color; only the hue varies, so every ring is
    ///      saturated and legible over any palette background (raw-byte RGB can go muddy/black).
    function _hsl(uint256 hue) private pure returns (string memory) {
        return string.concat("hsl(", hue.toString(), ",72%,58%)");
    }

    // ── param reads (mirrors SeedTraitsRenderer) ──────────────────────────────

    /// @dev The token's seed, or a deterministic fallback from the tokenId so the image is
    ///      always renderable (pre-mint preview, or a project with no seed source).
    function _seed(address token, uint256 tokenId) private view returns (bytes32) {
        (bytes32 value, bool isHash, bool isSet) = IAbxParams(token).tokenParam(tokenId, SEED_KEY);
        if (isSet && !isHash) return value;
        return keccak256(abi.encodePacked(token, tokenId));
    }

    /// @dev `palette` (HexColor) → "#rrggbb"; token scope falls back to contract scope (token
    ///      wins), and to a default when unset so the field always has a fill.
    function _palette(address token, uint256 tokenId) private view returns (string memory) {
        (bytes32 v, bool ok) = _literalParam(token, tokenId, PALETTE_KEY);
        if (!ok) return "#0e1a40";
        return TokenDataLib.decodeScalar(IAbxConfigurableParams.ParamType.HexColor, v);
    }

    function _literalParam(address token, uint256 tokenId, bytes32 key)
        private
        view
        returns (bytes32 value, bool ok)
    {
        bool isHash;
        bool isSet;
        (value, isHash, isSet) = IAbxParams(token).tokenParam(tokenId, key);
        if (isSet && !isHash) return (value, true);
        (value, isHash, isSet) = IAbxParams(token).contractParam(key);
        return (value, isSet && !isHash);
    }
}
