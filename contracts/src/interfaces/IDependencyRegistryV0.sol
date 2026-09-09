// SPDX-License-Identifier: LGPL-3.0-only
// Created By: Art Blocks Inc.
//
// Trimmed for ABX to the two load-bearing reads (specs/protocol/dependency-registry.md
// "The resolution seam") from Art Blocks' IDependencyRegistryV0
// (github.com/ArtBlocks/artblocks-contracts, contracts/interfaces/v0.8.x/
// IDependencyRegistryV0.sol). Signatures are byte-identical to AB's — the hard
// compatibility rule: any registry ABX consumers read from speaks this shape.

pragma solidity 0.8.28;

interface IDependencyRegistryV0 {
    /**
     * @notice Returns script for dependency type `dependencyNameAndVersion` at script index `index`.
     * @param dependencyNameAndVersion Dependency type to be queried.
     * @param index Index of script to be queried.
     * @dev Chunks are stored gzip'd + base64'd; consumers append them verbatim into
     *      `data:text/javascript;base64,` URIs — zero transcoding at read.
     */
    function getDependencyScript(bytes32 dependencyNameAndVersion, uint256 index)
        external
        view
        returns (string memory);

    /**
     * @notice Returns details for a given dependency type `dependencyNameAndVersion`.
     * @param dependencyNameAndVersion Name and version of dependency (i.e. "name@version") used to identify dependency.
     * @return nameAndVersion String representation of `dependencyNameAndVersion`.
     * @return licenseType License type for dependency
     * @return preferredCDN Preferred CDN URL for dependency
     * @return additionalCDNCount Count of additional CDN URLs for dependency
     * @return preferredRepository Preferred repository URL for dependency
     * @return additionalRepositoryCount Count of additional repository URLs for dependency
     * @return dependencyWebsite Project website URL for dependency
     * @return availableOnChain Whether dependency is available on chain
     * @return scriptCount Count of on-chain scripts for dependency
     */
    function getDependencyDetails(bytes32 dependencyNameAndVersion)
        external
        view
        returns (
            string memory nameAndVersion,
            string memory licenseType,
            string memory preferredCDN,
            uint24 additionalCDNCount,
            string memory preferredRepository,
            uint24 additionalRepositoryCount,
            string memory dependencyWebsite,
            bool availableOnChain,
            uint24 scriptCount
        );
}
