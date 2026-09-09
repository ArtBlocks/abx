// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";
import {LibString} from "solady/utils/LibString.sol";

import {IERC7572} from "../../interfaces/IERC7572.sol";
import {ContractURIStorage} from "../../libraries/ContractURIStorage.sol";
import {IAbxMetadataRenderer} from "../IAbxMetadataRenderer.sol";

/// @title ContractURI — configurable collection-URI strategy (ERC-7572)
/// @notice Resolves ERC-7572 `contractURI()` by the same precedence as {TokenURI}, one scope
///         up: an on-chain `renderer` if configured, else a full-URI override (a fixed
///         locator, e.g. an `ipfs://` collection document), else a pointer DERIVED on-chain
///         from a stored `base` and the protocol path grammar `{base}/{chainId}/{address}`,
///         else the empty string. The collection-scope analogue of `TokenURI`; the route
///         prefix (`/c`) lives in the configured base, not in bytecode. Re-pointing emits
///         `ContractURIUpdated`, and `lockContractURI` freezes the config forever.
/// @dev A token composes exactly one contract-URI strategy. The renderer address is the
///      toggle (non-zero ⇒ resolve on-chain). ERC-7572 defines no ERC-165 id (consumers
///      just call `contractURI()`), so this adds nothing to `supportsInterface`. Storage is
///      ERC-7201 (`ContractURIStorage`).
abstract contract ContractURI is Ownable, IERC7572 {
    using LibString for uint256;
    using LibString for address;

    error ContractURIConfigLocked();

    /// @notice The on-chain collection renderer was set (zero ⇒ resolve off-chain again).
    event ContractURIRendererSet(address indexed renderer);
    /// @notice The contract-URI config (base + override + renderer) was frozen forever.
    event ContractURIFrozen();

    /// @dev Set the URI config at initialize; announces it once.
    function _initContractURI(string calldata base, address renderer) internal {
        ContractURIStorage.Layout storage l = ContractURIStorage.layout();
        l.base = base;
        l.renderer = renderer;
        emit ContractURIUpdated();
    }

    /// @inheritdoc IERC7572
    /// @dev By precedence: on-chain renderer → full-URI override → derived base pointer.
    function contractURI() external view returns (string memory) {
        ContractURIStorage.Layout storage l = ContractURIStorage.layout();
        if (l.renderer != address(0)) {
            return IAbxMetadataRenderer(l.renderer).contractURI(address(this));
        }
        if (bytes(l.override_).length != 0) return l.override_;
        if (bytes(l.base).length == 0) return "";
        return
            string.concat(l.base, "/", block.chainid.toString(), "/", address(this).toHexString());
    }

    /// @notice Owner re-points the resolver base (used when no renderer/override is set).
    function setContractURIBase(string calldata base) external onlyOwner {
        ContractURIStorage.Layout storage l = ContractURIStorage.layout();
        if (l.locked) revert ContractURIConfigLocked();
        l.base = base;
        emit ContractURIUpdated();
    }

    /// @notice Owner sets (or clears, with an empty string) the full-URI override — wins over the base.
    function setContractURIOverride(string calldata uri) external onlyOwner {
        ContractURIStorage.Layout storage l = ContractURIStorage.layout();
        if (l.locked) revert ContractURIConfigLocked();
        l.override_ = uri;
        emit ContractURIUpdated();
    }

    /// @notice Owner sets the on-chain renderer (non-zero ⇒ resolve on-chain; zero ⇒ off-chain).
    function setContractURIRenderer(address renderer) external onlyOwner {
        ContractURIStorage.Layout storage l = ContractURIStorage.layout();
        if (l.locked) revert ContractURIConfigLocked();
        l.renderer = renderer;
        emit ContractURIRendererSet(renderer);
        emit ContractURIUpdated();
    }

    /// @notice Owner freezes the contract-URI config (base + override + renderer) forever.
    function lockContractURI() external onlyOwner {
        ContractURIStorage.layout().locked = true;
        emit ContractURIFrozen();
    }

    /// @notice The configured resolver base (empty ⇒ none).
    function contractURIBase() external view returns (string memory) {
        return ContractURIStorage.layout().base;
    }

    /// @notice The full-URI override (empty ⇒ none; the derived base path is used).
    function contractURIOverride() external view returns (string memory) {
        return ContractURIStorage.layout().override_;
    }

    /// @notice The configured on-chain renderer (zero ⇒ resolving off-chain).
    function contractURIRenderer() external view returns (address) {
        return ContractURIStorage.layout().renderer;
    }

    /// @notice Whether the contract-URI config is frozen.
    function contractURILocked() external view returns (bool) {
        return ContractURIStorage.layout().locked;
    }
}
