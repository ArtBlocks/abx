// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {ERC721} from "solady/tokens/ERC721.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IERC4906} from "../../interfaces/IERC4906.sol";
import {TokenURIStorage} from "../../libraries/TokenURIStorage.sol";
import {IAbxMetadataRenderer} from "../IAbxMetadataRenderer.sol";

/// @title TokenURI — the general, cardinality-neutral token-URI strategy
/// @notice Resolves `tokenURI(id)` by a fixed precedence:
///         1. an on-chain `renderer` if one is configured (assembles the JSON on-chain);
///         2. else a per-token override (`tokenOverride[id]`) if set — a fixed locator;
///         3. else a pointer DERIVED on-chain from a stored `base` and the protocol path
///            grammar `{base}/{chainId}/{address}/{tokenId}`;
///         4. else the empty string.
///         One strategy serves a 1/1 (token id 0) and a many-token contract identically —
///         cardinality is not a type. The route prefix (`/t`) lives in the configured base,
///         not in bytecode, so the host owns its routing; the contract only ever appends the
///         trailing coordinates. The path grammar is `{base}/{chainId}/{address}/{tokenId}`.
///         The owner can re-point the base, set/clear overrides, toggle
///         the renderer (each pings ERC-4906), and `lockTokenURI` to freeze all of it forever.
/// @dev `where it resolves` (off-chain base / per-token override / on-chain renderer) is
///      runtime config, not a separate type. **The renderer address is the toggle** —
///      non-zero ⇒ resolve on-chain — the same "non-zero pointer ⇒ call the interface" rule
///      the `reader` field representation uses, lifted to the whole document. Storage is
///      ERC-7201 (`TokenURIStorage`). Owns the ERC-4906 surface here.
abstract contract TokenURI is ERC721, Ownable, IERC4906 {
    using LibString for uint256;
    using LibString for address;

    error NonexistentToken();
    error TokenURIConfigLocked();

    /// @notice The resolver base was re-pointed (every token without an override may have changed).
    event TokenURIBaseSet(string base);
    /// @notice A per-token full-URI override was set (empty `uri` clears it).
    event TokenURIOverrideSet(uint256 indexed tokenId, string uri);
    /// @notice The on-chain metadata renderer was set (zero ⇒ resolve off-chain again).
    event TokenURIRendererSet(address indexed renderer);
    /// @notice The token-URI config (base + renderer + overrides) was frozen forever.
    event TokenURIFrozen();

    /// @dev Set the URI config at initialize (no event; the mint's Transfer is the signal).
    function _initTokenURI(string calldata base, address renderer) internal {
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        l.base = base;
        l.renderer = renderer;
    }

    /// @notice The token's metadata URI, by precedence: renderer → per-token override → derived base.
    function tokenURI(uint256 id) public view virtual override returns (string memory) {
        if (!_exists(id)) revert NonexistentToken();
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        if (l.renderer != address(0)) {
            return IAbxMetadataRenderer(l.renderer).tokenURI(address(this), id);
        }
        string memory ov = l.tokenOverride[id];
        if (bytes(ov).length != 0) return ov;
        if (bytes(l.base).length == 0) return "";
        return _composeTokenURI(l.base, id);
    }

    /// @dev The protocol path grammar: `{base}/{chainId}/{address}/{tokenId}`. The contract
    ///      appends only the trailing coordinates; the route prefix (`/t`) lives in `base`.
    ///      Address is the lowercase, 0x-prefixed 40-hex form (Solady `toHexString`).
    function _composeTokenURI(string memory base, uint256 id) private view returns (string memory) {
        return string.concat(
            base,
            "/",
            block.chainid.toString(),
            "/",
            address(this).toHexString(),
            "/",
            id.toString()
        );
    }

    /// @notice Owner re-points the resolver base (affects every token without an override).
    function setTokenURIBase(string calldata base) external onlyOwner {
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        if (l.locked) revert TokenURIConfigLocked();
        l.base = base;
        emit TokenURIBaseSet(base);
        emit BatchMetadataUpdate(0, type(uint256).max); // ERC-4906: every token's URI may have changed
    }

    /// @notice Owner sets (or clears, with an empty string) a per-token full-URI override.
    /// @dev A deliberate, rare escape — e.g. pinning one token to a fixed `ipfs://` document.
    ///      Non-empty ⇒ wins over the derived base path. Meaningful as an immutable terminal
    ///      state only when paired with {lockTokenURI} (see the protocol spec).
    function setTokenURIOverride(uint256 id, string calldata uri) external onlyOwner {
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        if (l.locked) revert TokenURIConfigLocked();
        l.tokenOverride[id] = uri;
        emit TokenURIOverrideSet(id, uri);
        emit MetadataUpdate(id); // ERC-4906: this one token's URI changed
    }

    /// @notice Owner sets the on-chain renderer (non-zero ⇒ resolve on-chain; zero ⇒ off-chain).
    function setTokenURIRenderer(address renderer) external onlyOwner {
        TokenURIStorage.Layout storage l = TokenURIStorage.layout();
        if (l.locked) revert TokenURIConfigLocked();
        l.renderer = renderer;
        emit TokenURIRendererSet(renderer);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    /// @notice Owner freezes the token-URI config (base + renderer + all overrides) forever.
    ///         With the token's fields also locked, the resolved metadata is provably immutable.
    function lockTokenURI() external onlyOwner {
        TokenURIStorage.layout().locked = true;
        emit TokenURIFrozen();
    }

    /// @notice The configured resolver base (empty ⇒ none).
    function tokenURIBase() external view returns (string memory) {
        return TokenURIStorage.layout().base;
    }

    /// @notice The per-token override for `id` (empty ⇒ none; the derived base path is used).
    function tokenURIOverride(uint256 id) external view returns (string memory) {
        return TokenURIStorage.layout().tokenOverride[id];
    }

    /// @notice The configured on-chain renderer (zero ⇒ resolving off-chain).
    function tokenURIRenderer() external view returns (address) {
        return TokenURIStorage.layout().renderer;
    }

    /// @notice Whether the token-URI config is frozen.
    function tokenURILocked() external view returns (bool) {
        return TokenURIStorage.layout().locked;
    }

    /// @notice ERC-165: this strategy adds the ERC-4906 id.
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return ERC721.supportsInterface(interfaceId) // 721 + 721Metadata + 165
            || interfaceId == 0x49064906; // ERC-4906
    }
}
