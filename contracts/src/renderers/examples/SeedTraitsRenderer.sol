// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {LibString} from "solady/utils/LibString.sol";

import {IAbxFieldRenderer} from "../../uri/IAbxFieldRenderer.sol";
import {IAbxParams} from "../../extensions/params/IAbxParams.sol";
import {
    IAbxConfigurableParams
} from "../../extensions/configurable-params/IAbxConfigurableParams.sol";
import {TokenDataLib} from "../../libraries/TokenDataLib.sol";

/// @title SeedTraitsRenderer — WORKED EXAMPLE: on-chain traits that DESCRIBE the paired art
/// @notice **Fork freely.** Not a canonical contract — the traits half of a fully in-chain drop,
///         designed to pair with {SeedSvgRenderer}. The load-bearing lesson: **on-chain, the image
///         renderer and the traits renderer must agree by construction** — so every trait here is
///         computed from the *same* `seed` bytes, with the *same* formulas, that {SeedSvgRenderer}
///         draws from. The metadata says exactly what the picture shows (N rings ⇒ `Rings: N`); it
///         cannot drift, because there's no separate off-chain step to fall out of sync.
///
///         Wire it by setting the collection-scope `attributes` field to the `renderer`
///         representation with `value = abi.encode(address(this))` — one deployment serves every
///         token; {AbxMetadataRenderer} embeds the array verbatim in `tokenURI`.
///
///         Techniques on display (swap the mappings for your project's):
///         - **numeric trait matched to the art** — `Rings` = `3 + (seed[0] % 6)`, byte-identical to
///           SeedSvgRenderer's ring count, emitted as a bare JSON number;
///         - **equal-weight table select** — `Weight` maps `seed[1] % 3` to the stroke family the
///           SVG draws (Fine/Medium/Bold, matching `1 + seed[1] % 3`);
///         - **weighted rarity via thresholds** — `Colorway` buckets the SVG's base hue
///           (`seed[3] * 360 / 256`) into named families with UNEQUAL cutoffs, so some colorways
///           are rarer than others (the gaps are the weights);
///         - **canonical param decode** — `Palette` reads the `palette` (HexColor) PostParam, token
///           scope falling back to contract scope (token wins — the tokenData merge rule), decoded
///           to `"#rrggbb"`; a collector reconfiguring `palette` changes both the SVG fill AND this
///           trait, in lockstep, on the next read;
///         - **omission over boilerplate** — no seed → the seed-derived traits vanish; no palette →
///           no `Palette`; collection surface (`tokenId == type(uint256).max`) → `[]`. Never reverts.
/// @dev Stateless and view-only, like every field renderer: same chain state → same bytes. Keep the
///      constants below in lockstep with {SeedSvgRenderer} — that lockstep IS the point.
contract SeedTraitsRenderer is IAbxFieldRenderer {
    error UnsupportedField();

    string private constant CONTENT_TYPE = "application/json";

    bytes32 private constant F_ATTRIBUTES = "attributes";
    bytes32 private constant SEED_KEY = "seed";
    bytes32 private constant PALETTE_KEY = "palette";

    // Must match SeedSvgRenderer: rings = RINGS_MIN + (seed[0] % RINGS_SPAN) → 3..8.
    uint256 private constant RINGS_MIN = 3;
    uint256 private constant RINGS_SPAN = 6;

    /// @inheritdoc IAbxFieldRenderer
    function render(address token, uint256 tokenId, bytes32 field)
        external
        view
        returns (string memory contentType, bytes memory data)
    {
        if (field != F_ATTRIBUTES) revert UnsupportedField();

        // collection surface (e.g. contractURI): no token → no traits, never a revert.
        if (tokenId == type(uint256).max) return (CONTENT_TYPE, bytes("[]"));

        string memory traits;

        // ── seed-derived traits — describe exactly what SeedSvgRenderer draws ──
        (bytes32 seed, bool hasSeed) = _literalTokenParam(token, tokenId, SEED_KEY);
        if (hasSeed) {
            traits = _append(traits, _numberTrait("Rings", RINGS_MIN + (uint8(seed[0]) % RINGS_SPAN)));
            traits = _append(traits, _stringTrait("Weight", _weight(uint8(seed[1]))));
            traits = _append(traits, _stringTrait("Colorway", _colorway(uint8(seed[3]))));
        }

        // ── palette — token scope falls back to contract scope (token wins) ──
        (bytes32 palette, bool hasPalette) = _literalParam(token, tokenId, PALETTE_KEY);
        if (hasPalette) {
            traits = _append(
                traits,
                _stringTrait(
                    "Palette",
                    TokenDataLib.decodeScalar(IAbxConfigurableParams.ParamType.HexColor, palette)
                )
            );
        }

        return (CONTENT_TYPE, bytes(string.concat("[", traits, "]")));
    }

    // ── the derivations (mirror SeedSvgRenderer's geometry) ─────────────────────

    /// @dev Stroke family: equal-weight select over `seed[1] % 3`, matching the SVG's
    ///      `stroke-width = 1 + (seed[1] % 3)`. (256 % 3 != 0 → a hair of modulo bias; fine for
    ///      flavor — bucket via thresholds if you need it exact.)
    function _weight(uint8 b) private pure returns (string memory) {
        string[3] memory names = ["Fine", "Medium", "Bold"];
        return names[b % 3];
    }

    /// @dev Colorway: name the SVG's base hue (`seed[3] * 360 / 256`) by family, with UNEQUAL cutoffs
    ///      so some are rarer than others (the weighted-rarity technique, but pointed at a hue you
    ///      can actually see in the rings).
    function _colorway(uint8 b) private pure returns (string memory) {
        uint256 hue = (uint256(b) * 360) / 256; // 0..359 — identical to SeedSvgRenderer's baseHue
        if (hue < 25) return "Ember"; //     25/360  = 6.9%
        if (hue < 70) return "Amber"; //     45/360  = 12.5%
        if (hue < 160) return "Verdant"; //  90/360  = 25%
        if (hue < 200) return "Teal"; //     40/360  = 11.1%
        if (hue < 265) return "Azure"; //    65/360  = 18.1%
        if (hue < 320) return "Violet"; //   55/360  = 15.3%
        return "Rose"; //                    40/360  = 11.1%
    }

    // ── attributes-array assembly ───────────────────────────────────────────--

    /// @dev One string-valued trait. Both halves are escaped here — the single emit point.
    function _stringTrait(string memory traitType, string memory value)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '{"trait_type":"',
            LibString.escapeJSON(traitType),
            '","value":"',
            LibString.escapeJSON(value),
            '"}'
        );
    }

    /// @dev One number-valued trait — the value is a bare JSON number, never quoted.
    function _numberTrait(string memory traitType, uint256 value)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '{"trait_type":"',
            LibString.escapeJSON(traitType),
            '","value":',
            LibString.toString(value),
            "}"
        );
    }

    /// @dev Comma-join accumulator: first item bare, the rest prefixed.
    function _append(string memory acc, string memory item) private pure returns (string memory) {
        return bytes(acc).length == 0 ? item : string.concat(acc, ",", item);
    }

    // ── param reads ─────────────────────────────────────────────────────────--

    /// @dev A token-scope literal param. Hash-backed (`valueIsHash`) values are content
    ///      pointers, not scalars — treated as unset here rather than misread.
    function _literalTokenParam(address token, uint256 tokenId, bytes32 key)
        private
        view
        returns (bytes32 value, bool ok)
    {
        bool isHash;
        bool isSet;
        (value, isHash, isSet) = IAbxParams(token).tokenParam(tokenId, key);
        return (value, isSet && !isHash);
    }

    /// @dev The tokenData merge rule for scalars: contract scope ∪ token scope, token wins.
    function _literalParam(address token, uint256 tokenId, bytes32 key)
        private
        view
        returns (bytes32 value, bool ok)
    {
        (value, ok) = _literalTokenParam(token, tokenId, key);
        if (ok) return (value, true);
        bool isHash;
        bool isSet;
        (value, isHash, isSet) = IAbxParams(token).contractParam(key);
        return (value, isSet && !isHash);
    }
}
