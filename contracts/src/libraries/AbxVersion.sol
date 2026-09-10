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
    /// @dev **3** — the first production-candidate generation. Runtime behavior matches the final
    ///      v2 build apart from this reported version. The bump gives the freshly synchronized and
    ///      source-clean deployment a distinct identity, while v2 remains a supported generation.
    ///
    ///      Whoever bumps this next: the SDK's `isCurrent*` probes in `packages/sdk/src/anchors.ts`
    ///      must move in lockstep, the way `AbxMetadataRenderer.SPEC_VERSION` and `isCurrentRenderer`
    ///      already do.
    uint16 internal constant CORE_VERSION = 3;
}
