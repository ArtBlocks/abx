// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IAbxParams} from "../extensions/params/IAbxParams.sol";
import {IAbxConfigurableParams} from
    "../extensions/configurable-params/IAbxConfigurableParams.sol";
import {IAbxAugmentHook} from "../extensions/configurable-params/IAbxParamHooks.sol";

/// @title TokenDataLib — the canonical `tokenData` decode + assembly, on-chain
/// @notice The Solidity twin of the off-chain serializer: field renderers use it to build the
///         flat `tokenData` JSON a program receives, byte-consistent with what the resolver
///         and render nodes produce (`specs/protocol/code-projects.md`). Every value is a JSON
///         string; the canonical decode does the conversion (`HexColor → "#rrggbb"`,
///         `DecimalRange` ÷ 1e10, `Bytes → base64`, …); `String` values are JSON-escaped here
///         — the single escaping point.
/// @dev INTERNAL library — inlined into field renderers (never into tokens, so no size
///      pressure on token implementations). The params store is enumerable on-chain (the
///      `IAbxParams` key getters, maintained in the write paths), so a field renderer can
///      enumerate the full surface — as the canonical generator does — or simply name the
///      keys its project uses; either way entries append in **lexicographic key order** to
///      match the canonical form. Augmented entries append last; a duplicated key resolves
///      last-wins in every mainstream JSON parser — exactly the "augment wins" rule. All
///      view/pure: this only ever runs in read contexts, so the base64/decimal work is free.
library TokenDataLib {
    uint256 private constant DECIMAL_SCALE = 1e10; // DecimalRange: fixed 10 decimals

    bytes32 private constant SEED_KEY = "seed";

    /// @dev The tokenData coordinates, which are emitted by {begin} and are never valid as param
    ///      keys. Mirrors `RESERVED_TOKEN_DATA_KEYS` in the SDK — two lists that have to agree.
    ///
    ///      Compared on the key's RENDERED NAME, not its raw word, and that distinction is the whole
    ///      finding: {keyToString} stops at the first zero byte, so `bytes32("seed\0<junk>")` is
    ///      unequal to `SEED_KEY` as a 32-byte word yet serializes as the JSON member `"seed"`. A
    ///      full-word comparison let exactly that through — an augment hook forged `seed`, `tokenId`,
    ///      `chainId` and `contractAddress` into the delivered document, appended LAST so a
    ///      last-wins parser (including `abx.js`) preferred the forgery over the real coordinate.
    ///      Truncating first closes the class rather than the one key.
    function _isReservedKey(bytes32 key) private pure returns (bool) {
        bytes32 name = _renderedName(key);
        return name == SEED_KEY || name == "chainId" || name == "contractAddress"
            || name == "tokenId";
    }

    /// @dev The key as {keyToString} will render it, still packed: everything from the first zero
    ///      byte onward cleared. Comparing this is comparing what a consumer actually sees.
    function _renderedName(bytes32 key) private pure returns (bytes32) {
        uint256 len;
        while (len < 32 && key[len] != 0) ++len;
        if (len == 32) return key;
        return key & bytes32(~uint256(0) << (256 - len * 8));
    }

    /// @notice Open the object with the reserved coordinates — `chainId` (the one JSON
    ///         number), `contractAddress` (lowercase hex), `tokenId` (decimal string) — plus
    ///         `seed` iff assigned.
    function begin(address token, uint256 tokenId) internal view returns (string memory out) {
        out = string.concat(
            '{"chainId":',
            LibString.toString(block.chainid),
            ',"contractAddress":"',
            LibString.toHexString(token),
            '","tokenId":"',
            LibString.toString(tokenId),
            '"'
        );
        (bytes32 seed,, bool isSet) = IAbxParams(token).tokenParam(tokenId, SEED_KEY);
        if (isSet) {
            out = string.concat(out, ',"seed":"', LibString.toHexString(uint256(seed), 32), '"');
        }
    }

    /// @notice Close the object.
    function finish(string memory out) internal pure returns (string memory) {
        return string.concat(out, "}");
    }

    // ── entries (append in lexicographic key order) ─────────────────────────--

    /// @notice Append a scalar param, canonically decoded per its type. Reads the token scope,
    ///         falling back to the contract scope (token wins). Unset ⇒ appended nothing.
    function scalarEntry(
        string memory out,
        address token,
        uint256 tokenId,
        bytes32 key,
        IAbxConfigurableParams.ParamType paramType
    ) internal view returns (string memory) {
        (bytes32 value, bool isSet) = _readParam(token, tokenId, key);
        if (!isSet) return out;
        return string.concat(
            out, ',"', LibString.escapeJSON(keyToString(key)), '":"', decodeScalar(paramType, value), '"'
        );
    }

    /// @notice Append a `Select` param as its chosen option string. Unset ⇒ nothing.
    function selectEntry(
        string memory out,
        address token,
        uint256 tokenId,
        bytes32 key,
        string[] memory options
    ) internal view returns (string memory) {
        (bytes32 value, bool isSet) = _readParam(token, tokenId, key);
        if (!isSet || uint256(value) >= options.length) return out;
        return string.concat(
            out,
            ',"',
            LibString.escapeJSON(keyToString(key)),
            '":"',
            LibString.escapeJSON(options[uint256(value)]),
            '"'
        );
    }

    /// @notice Append a `String` param (data-backed): UTF-8 passthrough, JSON-escaped here —
    ///         the single escaping point. Unset ⇒ nothing.
    function stringEntry(string memory out, address token, uint256 tokenId, bytes32 key)
        internal
        view
        returns (string memory)
    {
        bytes memory data = _readParamData(token, tokenId, key);
        if (data.length == 0) return out;
        return string.concat(
            out, ',"', LibString.escapeJSON(keyToString(key)), '":"', LibString.escapeJSON(string(data)), '"'
        );
    }

    /// @notice Append a `Bytes` param (data-backed): base64 at read, never stored. Unset ⇒
    ///         nothing.
    function bytesEntry(string memory out, address token, uint256 tokenId, bytes32 key)
        internal
        view
        returns (string memory)
    {
        bytes memory data = _readParamData(token, tokenId, key);
        if (data.length == 0) return out;
        return string.concat(out, ',"', LibString.escapeJSON(keyToString(key)), '":"', Base64.encode(data), '"');
    }

    /// @notice Append the augment hook's entries — last, so a duplicated key resolves to the
    ///         augmented value (augment wins). Values arrive as final canonical strings;
    ///         escaping happens here. No hook / no entries ⇒ nothing.
    function augmentedEntries(string memory out, address token, uint256 tokenId)
        internal
        view
        returns (string memory)
    {
        (, address augmentHook,) = IAbxConfigurableParams(token).paramHooks();
        if (augmentHook == address(0)) return out;
        IAbxAugmentHook.AugmentedParam[] memory entries =
            IAbxAugmentHook(augmentHook).augmentTokenParams(token, tokenId);
        for (uint256 i; i < entries.length; ++i) {
            // Coordinates win: the hook is an owner-supplied contract, and letting it name a
            // reserved key let it forge the very things the work trusts as ground truth —
            // emitting a second `"seed"` (or `"tokenId"`, `"chainId"`, `"contractAddress"`) member
            // that a last-wins JSON parser prefers over the real one. The docs and the off-chain
            // serializer both filter this set; this is the on-chain half catching up.
            if (_isReservedKey(entries[i].key)) continue;
            out = string.concat(
                out,
                ',"',
                LibString.escapeJSON(keyToString(entries[i].key)),
                '":"',
                LibString.escapeJSON(entries[i].value),
                '"'
            );
        }
        return out;
    }

    // ── the canonical decode ────────────────────────────────────────────────--

    /// @notice One scalar value → its canonical string (the versioned decode, on-chain).
    function decodeScalar(IAbxConfigurableParams.ParamType t, bytes32 value)
        internal
        pure
        returns (string memory)
    {
        uint256 v = uint256(value);
        if (t == IAbxConfigurableParams.ParamType.Bool) {
            return v == 0 ? "false" : "true";
        }
        if (t == IAbxConfigurableParams.ParamType.HexColor) {
            // Masked, not validated. Solady's `toHexStringNoPrefix(v, 3)` REVERTS
            // (`HexLengthInsufficient`) on a value above 0xFFFFFF, and this decode runs inside
            // `tokenURI` — a view the whole ecosystem depends on and which this renderer documents
            // as never reverting for params reasons. Two ordinary owner operations in the wrong
            // order reached it (write a raw value, then attach a `HexColor` schema to that key),
            // and there was no way back: the raw setters close once a key is governed, no governed
            // contract-scope write path exists, and schemas cannot be deleted. So every
            // `tokenURI` in the collection reverted, permanently.
            //
            // Clamping is the honest failure here. An out-of-domain colour renders as some colour
            // rather than taking the whole collection's metadata down, and the write paths still
            // validate the domain properly for anything set through the governed path. Bricking is
            // strictly worse than a wrong shade of blue.
            return string.concat("#", LibString.toHexStringNoPrefix(uint256(v) & 0xffffff, 3));
        }
        if (t == IAbxConfigurableParams.ParamType.Int256Range) {
            // reinterpreting the bytes32 as two's-complement signed is the type's encoding.
            // forge-lint: disable-next-line(unsafe-typecast)
            return LibString.toString(int256(v));
        }
        if (t == IAbxConfigurableParams.ParamType.DecimalRange) {
            return decodeDecimal(v);
        }
        // Uint256Range · Timestamp (unix seconds) · Select-as-index fallback → decimal
        return LibString.toString(v);
    }

    /// @notice `DecimalRange`'s fixed-point form: the stored uint ÷ 1e10, trailing zeros
    ///         trimmed, no decimal point when whole (`15e9 → "1.5"`, `1e10 → "1"`).
    function decodeDecimal(uint256 v) internal pure returns (string memory) {
        uint256 whole = v / DECIMAL_SCALE;
        uint256 frac = v % DECIMAL_SCALE;
        if (frac == 0) return LibString.toString(whole);
        // fixed 10 fractional digits, then trim trailing zeros
        bytes memory digits = bytes(LibString.toString(frac + DECIMAL_SCALE)); // "1" + 10 digits
        uint256 end = digits.length;
        while (digits[end - 1] == "0") --end;
        bytes memory fracOut = new bytes(end - 1);
        for (uint256 i = 1; i < end; ++i) {
            fracOut[i - 1] = digits[i];
        }
        return string.concat(LibString.toString(whole), ".", string(fracOut));
    }

    /// @notice The schema-less literal rule (the SDK serializer's `decodeTagLoose`, on-chain):
    ///         trailing zeros trimmed; all-printable-ASCII (and non-empty) → the text,
    ///         JSON-escaped here per the single-escaping-point rule; anything else → the full
    ///         bytes32 hex. Shared by every on-chain consumer that decodes an unschema'd
    ///         literal (the canonical generator, the canonical metadata renderer).
    function decodeTagLoose(bytes32 value) internal pure returns (string memory) {
        uint256 len = 32;
        while (len != 0 && value[len - 1] == 0) --len;
        if (len != 0) {
            bytes memory text = new bytes(len);
            bool ascii = true;
            for (uint256 i; i < len; ++i) {
                bytes1 c = value[i];
                if (c < 0x20 || c >= 0x7f) {
                    ascii = false;
                    break;
                }
                text[i] = c;
            }
            if (ascii) return LibString.escapeJSON(string(text));
        }
        return LibString.toHexString(uint256(value), 32);
    }

    /// @notice A readable-ASCII `bytes32` key as a string (trailing zeros trimmed).
    function keyToString(bytes32 key) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && key[len] != 0) ++len;
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = key[i];
        }
        return string(out);
    }

    // ── internals ─────────────────────────────────────────────────────────────

    /// @dev tokenData's merge rule: contract scope ∪ token scope, token wins.
    function _readParam(address token, uint256 tokenId, bytes32 key)
        private
        view
        returns (bytes32 value, bool isSet)
    {
        bool isHash;
        (value, isHash, isSet) = IAbxParams(token).tokenParam(tokenId, key);
        if (isSet && !isHash) return (value, true);
        (value, isHash, isSet) = IAbxParams(token).contractParam(key);
        if (isSet && !isHash) return (value, true);
        return (bytes32(0), false);
    }

    /// @dev Data-backed read with the same token-wins fallback.
    function _readParamData(address token, uint256 tokenId, bytes32 key)
        private
        view
        returns (bytes memory data)
    {
        data = IAbxParams(token).tokenParamData(tokenId, key);
        if (data.length != 0) return data;
        return IAbxParams(token).contractParamData(key);
    }
}
