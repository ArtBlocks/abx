// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title AbxVersion — core protocol version
/// @notice The core ABX spec version emitted by the `AbxDeployed` beacon. This is the
///         *core* version only — each extension owns its own id and version,
///         co-located with the extension (e.g. `RoyaltyExtension`), so adding an
///         extension never touches this file.
library AbxVersion {
    /// @notice Core ABX spec version (emitted in `AbxDeployed`, and readable as `abxVersion()`).
    ///
    /// @dev **4** — the generation after the first production candidate (v3). Token-runtime
    ///      changes: `SeriesImage` reserves its issuance cursor before minting; a `OneOfOneImage`
    ///      mints at most once in its lifetime, so a burned 1/1 stays burned; the param errors carry
    ///      their key and context and are declared on the interfaces, so they decode against every
    ///      token's ABI; the params write path refuses codeless hooks, oversized blobs, coordinate
    ///      keys, unenforced schema bounds and malformed `Select` labels; and edition transfers skip
    ///      the creator-token library hop for mints, burns and a missing or suspended validator,
    ///      and the transfer-hook hop when no hook is set or for a self-transfer. v3 and v2 remain
    ///      supported generations.
    ///
    ///      Whoever bumps this next: `ABX_CORE_VERSION` in `packages/sdk/src/anchors.ts` must move
    ///      in lockstep (`packages/sdk/test/anchor-version.test.ts` pins the two together), the way
    ///      `AbxMetadataRenderer.SPEC_VERSION` and `isCurrentRenderer` already do.
    uint16 internal constant CORE_VERSION = 4;
}
