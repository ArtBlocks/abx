// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title AbxSalts — canonical CREATE2 salts for ABX's shared infrastructure
/// @notice One well-known salt per canonical singleton / factory. Deployed through the keyless
///         CREATE2 proxy (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, present on every EVM chain
///         and what `forge` routes `new X{salt: …}()` through), an identical salt + identical
///         initcode yields the **same address on every chain**. So the whole infra set is
///         cross-chain-identical — deploy on a new chain and the addresses already match the
///         manifest, computable before the first tx.
///
///         The one exception is {AbxGenerator}: its constructor bakes chain-specific immutables
///         (per-chain runtime-asset SSTORE2 pointers and the dependency-registry address), so its
///         initcode — hence its address — legitimately differs per chain even with a fixed salt.
/// @dev The `.v1` suffix is the **salt-scheme** version, NOT a contract's spec version. Shipping
///      new contract code changes the initcode and therefore the deployed address on its own, so
///      you never bump these for a normal upgrade (a new AbxMetadataRenderer spec re-addresses
///      automatically). Bump a salt only to deliberately force a fresh address for byte-identical
///      code — rare, and a conscious break.
library AbxSalts {
    bytes32 internal constant ONE_OF_ONE_FACTORY = keccak256("abx.factory.one-of-one.v1");
    bytes32 internal constant SERIES_FACTORY = keccak256("abx.factory.series.v1");
    bytes32 internal constant SERIES_CODE_FACTORY = keccak256("abx.factory.series-code.v1");
    bytes32 internal constant RENDERER = keccak256("abx.renderer.v1");
    bytes32 internal constant CHUNK_STORE = keccak256("abx.chunk-store.v1");
    bytes32 internal constant FIXED_PRICE_MINTER = keccak256("abx.minter.fixed-price.v1");
    bytes32 internal constant SEED_SOURCE = keccak256("abx.seed-source.v1");
    bytes32 internal constant GENERATOR = keccak256("abx.generator.v1");

    // ERC-1155 editions (twins of the above; naming follows the parity plan verbatim).
    bytes32 internal constant ONE_OF_ONE_EDITION_FACTORY =
        keccak256("abx.one-of-one-edition-factory.v1");
    bytes32 internal constant EDITION_FACTORY = keccak256("abx.edition-factory.v1");
    bytes32 internal constant EDITION_CODE_FACTORY = keccak256("abx.edition-code-factory.v1");
    bytes32 internal constant FIXED_PRICE_MINTER_1155 =
        keccak256("abx.fixed-price-minter-1155.v1");

    // ── delegatecalled write-path libraries ──────────────────────────────────────
    //
    // Salted explicitly, and deployed by {DeployLibraries} through the same keyless proxy, because
    // "forge happens to CREATE2 an auto-linked library" is a property of the toolchain rather than
    // of this repo. It has been true in every recorded deploy — `AbxParamsLib` landed at one address
    // on two chains from deployer nonces 215 apart — but nothing here asked for it, and an
    // architectural decision was once made on the assumption that the opposite was true. Naming the
    // salts makes the determinism ours: stated, reproducible, and checkable before a tx is sent.
    bytes32 internal constant PARAMS_LIB = keccak256("abx.lib.params.v1");
    bytes32 internal constant CODE_LIB = keccak256("abx.lib.code.v1");
    bytes32 internal constant EDITION_LIB = keccak256("abx.lib.edition.v1");
    /// @dev The metadata field store, linked by ALL SIX token types (the only library that is).
    bytes32 internal constant METADATA_LIB = keccak256("abx.lib.metadata.v1");
}
