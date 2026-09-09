// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title Erc1155SupplyStorage — per-id live supply (+ the id-space high-water mark), ERC-7201 namespaced
/// @notice The ERC-1155 analogue of `SupplyStorage`: the number of copies of each id that exist
///         right now (minted − burned), maintained UNCONDITIONALLY by `AbxErc1155Base`'s
///         `_afterTokenTransfer` — every 1155 token gets this bookkeeping, whether or not it
///         composes the opt-in `EditionSupply` extension (mirrors how `SupplyStorage`'s single
///         counter is core-level and unconditional for ERC-721). The `EditionSupply` extension
///         mixin is a plain importer of this SAME library for its `totalSupply(id)`/`exists(id)`
///         reads — no inheritance coupling between the base and the extension is needed, since a
///         freestanding ERC-7201 library needs none to be shared across sibling mixins.
/// @dev `idWatermark` is a separate concern living in the same file for convenience: the highest
///      id + 1 that has EVER received a mint (monotonic, never decremented — a full burn of the
///      top id does not lower it). `MaxInvocations`-capped 1155 tokens (`EditionImage`,
///      `EditionCode`) read it as their `_maxInvocationsFloor()` — the id-space analogue of a
///      Series' "can't lower the cap below totalSupply()" promise, generalized to non-sequential
///      id assignment: an edition mint names its id explicitly (no natural "tokens minted so far"
///      cursor to reuse), so the floor has to be tracked as its own high-water mark instead of
///      derived from a live count. `OneOfOneEdition` (no id-space cap) never touches it.
library Erc1155SupplyStorage {
    /// @custom:storage-location erc7201:abx.storage.erc1155-supply
    struct Layout {
        mapping(uint256 => uint256) totalSupply; // per-id live count (minted − burned)
        uint256 idWatermark; // highest id + 1 ever minted; monotonic non-decreasing
        // Opt-in burn (B44): false unless the creator enabled it at deploy. Appended, so the
        // existing layout is unchanged. When true, the core `burn` path is open (holder-or-approved);
        // when false there is no way to destroy a copy. Set once at init, immutable after.
        bool burnable;
    }

    // keccak256(abi.encode(uint256(keccak256("abx.storage.erc1155-supply")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_SLOT =
        0xdcc250bca9557e5ac303767bfedf6db08e36e88a508d05ccff5ec9e75fba5d00;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := STORAGE_SLOT
        }
    }
}
