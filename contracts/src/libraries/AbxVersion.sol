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
    /// @dev **2** — the security remediation of 2026-08. Bumped because the freshness probes could
    ///      not see it: `isCurrentFactory` asked whether the implementation *has* `totalSupply()`,
    ///      a shape question every pre-remediation build also answers yes to. So an operator holding
    ///      a stale factory would keep stamping clones on a vulnerable implementation while the CLI
    ///      reported the anchor as `resolved`. A version is only a safety control if something reads
    ///      it — `abxVersion()` existed on every token the whole time and nothing gated on it.
    ///
    ///      Whoever bumps this next: the SDK's `isCurrent*` probes in `packages/sdk/src/anchors.ts`
    ///      must move in lockstep, the way `AbxMetadataRenderer.SPEC_VERSION` and `isCurrentRenderer`
    ///      already do.
    uint16 internal constant CORE_VERSION = 2;
}
