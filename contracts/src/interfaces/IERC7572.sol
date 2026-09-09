// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title IERC7572 — Contract-level (= project-level) metadata (Register 1 standard)
/// @notice `contractURI()` is the marketplace standard for collection name/description/image.
///         ERC-7572 defines no ERC-165 interface id; consumers just call `contractURI()`.
interface IERC7572 {
    /// @notice The contract-level metadata URI changed.
    event ContractURIUpdated();

    /// @notice URI for contract-level metadata (collection name, description, image, …).
    function contractURI() external view returns (string memory);
}
