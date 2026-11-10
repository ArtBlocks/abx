# @artblocks/abx-sdk

## 0.10.4

### Patch Changes

- 9865594: Development-only maintenance: update the HTML parser used by SDK conformance tests to its ESM-only release. The published runtime API and dependencies are unchanged.
- d5a80e1: Drop-in maintenance update for creators and SDK consumers: update production dependencies and normalize missing OS credential records across Keyring versions without retrying denied reads or deleting absent credentials.

## 0.10.3

### Patch Changes

- f298236: Contain malformed upstream responses, reject deprecated IPv6 transition destinations, and preserve indexing recovery boundaries without adding scans for healthy projects. Harden local preview and effects requests and keep wallet session URL files private.

## 0.10.2

### Patch Changes

- 0be353f: Publish through the main-only GitHub publishing environment and validate each package's restricted npm trusted publisher. Package runtime behavior is unchanged.

## 0.10.1

### Patch Changes

- d74b1eb: Keep transport configuration out of public project state; bound project-content fetching to public network destinations and limited decoded bodies. Authenticate local signing sessions, verify completed transaction intent, contain preview file reads, preserve queued indexer deltas, and require authentication for public effects listeners. Scope deterministic image writes to their collection and document reference hosting limits and migrations.

## 0.10.0

### Minor Changes

- 8091fe3: Serve each token's live application at the root of a fixed-length hashed content subdomain. Keep
  legacy resolver and collection links as compatible entrypoints, persist rebuildable token-root
  lookups in the reference self-hosted resolver, and honor advertised provider URL templates in remote
  captures. Document contract URI compatibility and the security limits of sandbox-only hosting.

### Patch Changes

- 4eb24b6: Preserve configured resolver path prefixes in live-view fallbacks and keep descriptor diagnostic
  base URLs from overriding remote capture transport when a direct content scheme is unavailable.

## 0.9.0

### Minor Changes

- 935fb00: Serve resolver project documents on collection-scoped content origins configured by
  ABX_CONTENT_DOMAIN. Preserve existing metadata and animation URLs, provide marketplace-compatible
  live-view wrappers and canonical direct links, and keep artifact bytes unchanged across redirects.
  Self-hosted documents use opaque-origin sandboxing when no content domain is configured. Advertise
  content addressing in service discovery and document the browser storage and wallet implications.
- 9e1129e: Drop-in for existing SDK consumers: `analyzeScript` adds an optional `inlineHtml` finding and the SDK exports `inlineScriptUnterminatedAt`. Detect raw script content that the current generated HTML cannot terminate. The CLI warns during inspect, ERC-721/ERC-1155 script deployment, and script replacement without executing or rewriting the source. Document context-specific author fixes and previewing before locking. No contract or generator behavior changes.

### Patch Changes

- b48af22: Effects runners capture direct collection content URLs from ABX_CONTENT_DOMAIN or remote service
  discovery. This keeps browser navigation status checks on the actual document and avoids marketplace
  wrappers in automated capture. Document the shared resolver/effects configuration in the bundled skill.

  Top-level browser live-view requests use HTTP redirects so existing capture clients see the final
  artwork status. Marketplace frames and server-side downloads retain the embeddable wrapper.

- 8be5eab: Keep the localhost root available as a local resolver control-plane alias when collection content
  uses localhost subdomains. Default effects-runner transport can still discover projects and state;
  collection subdomains continue to reject control routes, and production content roots stay restricted.

## 0.8.0

### Minor Changes

- f1654fd: Add automatic creator-wallet payment: sufficiently funded wallets pay native value and network
  fees; eligible zero-value calls otherwise use sponsorship. Introduce `--embedded` with `--sponsor`
  as its backwards-compatible alias, reuse one agent grant, and verify returned signing payloads
  against the local transaction intent before signing. Self-payment requires live provider support.
  Structured deploy plans use schema version 3 with the automatic payment policy.

## 0.7.1

### Patch Changes

- e497ffe: Mark Arbitrum Sepolia, Arbitrum, Base, and Ethereum mainnet as supported. Align the network registry,
  CLI capabilities, qualification notices, and public network table with their supported status.

## 0.7.0

### Minor Changes

- 4226fe8: Drop-in for existing service integrators: add optional managed-renderer constraints to service descriptors, and surface CPU/headless, capture-delay, and GPU-worker guidance in remote inspection, code deployment, and remote verification.

## 0.6.0

### Minor Changes

- 347f196: Discover an authenticated creator RPC through a remote's `abx-creator-rpc/v1` service interface,
  using ABX Services as the zero-config provider while preserving explicit RPC configuration and the
  shipped public endpoints as failover.

## 0.5.0

### Minor Changes

- 9cd961f: Drop-in for existing consumers; Ethereum is a new opt-in production-beta network.

  Add canonical Ethereum deployments, public RPC fallbacks, the recommended transfer validator, and the standard production warning.

## 0.4.2

### Patch Changes

- f4e091e: Fail over across independent public RPCs by default, show unavailable fallbacks in `abx doctor`, preserve submitted transaction hashes during receipt outages, add Base mainnet's qualified recommended 721C validator, and warn before a collection image masks every token render.

## 0.4.1

### Patch Changes

- 997e44d: Improve project inspection, render verification, PostParam authority guidance, creator-wallet setup, and deterministic contract-deploy previews.

## 0.4.0

### Minor Changes

- d891b2a: Drop-in for existing consumers; Arbitrum is a new opt-in production-beta network.

  Add canonical Arbitrum deployments and enable the network behind the standard production warning.

## 0.3.0

### Minor Changes

- 1cd7c8c: Drop-in for existing consumers; Arbitrum Sepolia is a new opt-in network.

  Add experimental Arbitrum Sepolia support and stage Arbitrum production metadata for its later canonical deployment.

## 0.2.0

### Minor Changes

- 7947ba9: Drop-in for read-only consumers. Hosts that serve stored images should adopt `storedImageType`.

  On-chain raster images now display correctly. Stored `image` bytes are labelled with the new reserved
  `abx_image_type` field, and fall back to `image/svg+xml` when it is unset. Before this change, a JPEG
  or PNG staged with `--onchain-image` was served as SVG, which browsers show as a broken image.

  - SDK: `METADATA_FIELD.imageType`, `storedImageType`, `isDeclarableImageType`, and
    `DEFAULT_STORED_IMAGE_TYPE`. `isCurrentRenderer` now requires renderer spec v12, and the
    canonical renderer address points at the v12 build.
  - CLI: `deploy --onchain-image`, `deploy-series --onchain-image`, and `set-field --field image --file`
    declare a raster's type from its file extension. They refuse formats browsers don't draw, such as
    TIFF, PSD, video, and files without an extension, before anything is staged.
  - Token API: the image route, the `/data/image` route, and the `artifacts` manifest serve the
    declared type.

## 0.1.0

### Minor Changes

- 21e3d6c: Drop-in for existing v2 integrations; new deployments use the canonical v3 contracts.
  Record the synchronized v3 factory generation and testnet deployments, retain full v2 service
  compatibility (including already-assigned v2 sale minters), and update the renderer scaffold to
  `abx-contracts` 3.0.0.
- 22abce8: Generalize the creator-wallet sponsorship lane to direct zero-value contract creation and
  receipt-dependent on-chain image staging. Add `abx deploy-contract` for exact Foundry artifact or
  initcode deployment through any signing lane.
- ea57f7a: Add provider-neutral remote interface discovery, the ABX Creators account API client, and the Base
  Sepolia creator-wallet `--sponsor` signing lane. A provider catalog may advertise its account and
  wallet interfaces at a separate HTTPS origin without changing existing same-origin remotes.
- 3ddba71: Drop-in for existing SDK callers; new consumers can inspect contract-generation compatibility.
  Add the append-only generation registry, stable lookup helpers, and lifecycle and operation support
  to provenance results.
- 9065128: Drop-in for existing clients; service consumers can now inspect verified contract-generation facts.
  Advertise understood generations and include a project generation in summaries and status responses
  only when factory provenance and the on-chain core version agree.

### Patch Changes

- 4d5e2b1: Return minimal metadata for unminted token positions and keep their image, data, and live-view URLs unavailable until mint.
- 56973c4: Preserve `maxInvocations` as an exact uint256 value instead of narrowing it through a JavaScript
  number. Reuse an existing hosted-service credential on login and add self-service API-key listing
  and revocation for accounts at their active-key limit.
- 2290b0a: Recover ambiguous creator-wallet submissions through the existing operation status instead of replaying them. Sponsored sends now keep polling safely when the provider response is temporarily unknown and surface the operation ID if reconciliation cannot complete.
- b9197bc: Record the exact-match canonical Robinhood Chain production deployment while keeping the network
  disabled until its services and low-value acceptance gates pass.
- 8ccbede: Enable Robinhood Chain production as beta after canonical deployment, paired-testnet qualification,
  and managed-service validation. Surface the same real-funds warning and testnet-first gate used for
  other production beta networks.
- d925eb1: Breaking only for SDK callers that directly prepared an unsupported sponsored `to: null` request;
  drop-in for existing hot, wallet, and unsigned deployments. Route sponsored custom-contract
  deployments through ABX's existing keyless CREATE2 proxy, expose the exact signer-bound salt and
  predicted address, verify code after confirmation, and document the proxy constructor-caller boundary.
- 8f35dae: Prepare package metadata, release notes, and public-facing source comments for the initial public
  source release.
- 719b9fe: Make the bundled skill read network and sponsorship support from CLI capabilities and the live
  service descriptor instead of a hardcoded network list. Refresh public documentation references in
  the published packages.
- c2400a7: Stage Robinhood Chain and its testnet as disabled qualification targets, keep the network registry
  focused on the current roadmap, and stop sale inspection from turning RPC read failures into false
  zero-state results.
- 3d7fe3c: Record the verified canonical Robinhood Chain Testnet deployment and enable the network for
  experimental qualification with explicit CLI and agent guidance.
- 7b462e2: Update the SDK's Viem dependency to the latest compatible patch release.
- ddb2e0b: Refuse irreversible URI locks when the current token or collection base uses `abx.io`. Clarify that
  managed resolver URLs must remain mutable unless a creator-controlled domain is routed and verified.
- 4512962: Enable Base production as beta, add a keyless read fallback, and surface production risk and paired-testnet guidance in the CLI, agent skill, and public docs.
- 76cfc6a: Follow each remote service interface's advertised origin so provider catalogs can separate token data from account and control APIs.
- 5522192: Record the source-verified Base production contract deployment while keeping Base disabled for CLI
  use until the separate beta-enablement release.

## 0.1.0-alpha.49

### Patch Changes

- 719b9fe: Make the bundled skill read network and sponsorship support from CLI capabilities and the live
  service descriptor instead of a hardcoded network list. Refresh public documentation references in
  the published packages.

## 0.1.0-alpha.48

### Patch Changes

- 4d5e2b1: Return minimal metadata for unminted token positions and keep their image, data, and live-view URLs unavailable until mint.

## 0.1.0-alpha.47

### Patch Changes

- 56973c4: Preserve `maxInvocations` as an exact uint256 value instead of narrowing it through a JavaScript
  number. Reuse an existing hosted-service credential on login and add self-service API-key listing
  and revocation for accounts at their active-key limit.

## 0.1.0-alpha.46

### Patch Changes

- ddb2e0b: Refuse irreversible URI locks when the current token or collection base uses `abx.io`. Clarify that
  managed resolver URLs must remain mutable unless a creator-controlled domain is routed and verified.
- 76cfc6a: Follow each remote service interface's advertised origin so provider catalogs can separate token data from account and control APIs.

## 0.1.0-alpha.45

### Patch Changes

- d925eb1: Breaking only for SDK callers that directly prepared an unsupported sponsored `to: null` request;
  drop-in for existing hot, wallet, and unsigned deployments. Route sponsored custom-contract
  deployments through ABX's existing keyless CREATE2 proxy, expose the exact signer-bound salt and
  predicted address, verify code after confirmation, and document the proxy constructor-caller boundary.

## 0.1.0-alpha.44

### Minor Changes

- 22abce8: Generalize the creator-wallet sponsorship lane to direct zero-value contract creation and
  receipt-dependent on-chain image staging. Add `abx deploy-contract` for exact Foundry artifact or
  initcode deployment through any signing lane.

## 0.1.0-alpha.43

### Patch Changes

- 2290b0a: Recover ambiguous creator-wallet submissions through the existing operation status instead of replaying them. Sponsored sends now keep polling safely when the provider response is temporarily unknown and surface the operation ID if reconciliation cannot complete.

## 0.1.0-alpha.42

### Minor Changes

- ea57f7a: Add provider-neutral remote interface discovery, the ABX Creators account API client, and the Base
  Sepolia creator-wallet `--sponsor` signing lane. A provider catalog may advertise its account and
  wallet interfaces at a separate HTTPS origin without changing existing same-origin remotes.

## 0.1.0-alpha.41

### Patch Changes

- 8ccbede: Enable Robinhood Chain production as beta after canonical deployment, paired-testnet qualification,
  and managed-service validation. Surface the same real-funds warning and testnet-first gate used for
  other production beta networks.

## 0.1.0-alpha.40

### Patch Changes

- b9197bc: Record the exact-match canonical Robinhood Chain production deployment while keeping the network
  disabled until its services and low-value acceptance gates pass.

## 0.1.0-alpha.39

### Patch Changes

- 3d7fe3c: Record the verified canonical Robinhood Chain Testnet deployment and enable the network for
  experimental qualification with explicit CLI and agent guidance.
- 7b462e2: Update the SDK's Viem dependency to the latest compatible patch release.

## 0.1.0-alpha.38

### Patch Changes

- c2400a7: Stage Robinhood Chain and its testnet as disabled qualification targets, keep the network registry
  focused on the current roadmap, and stop sale inspection from turning RPC read failures into false
  zero-state results.

## 0.1.0-alpha.37

### Patch Changes

- 4512962: Enable Base production as beta, add a keyless read fallback, and surface production risk and paired-testnet guidance in the CLI, agent skill, and public docs.

## 0.1.0-alpha.36

### Patch Changes

- 5522192: Record the source-verified Base production contract deployment while keeping Base disabled for CLI
  use until the separate beta-enablement release.

## 0.1.0-alpha.35

### Minor Changes

- 21e3d6c: Drop-in for existing v2 integrations; new deployments use the v3 production-candidate contracts.
  Record the synchronized v3 factory generation and testnet deployments, retain full v2 service
  compatibility (including already-assigned v2 sale minters), and update the renderer scaffold to
  `abx-contracts` 3.0.0.

## 0.1.0-alpha.34

### Minor Changes

- 3ddba71: Drop-in for existing SDK callers; new consumers can inspect contract-generation compatibility.
  Add the append-only generation registry, stable lookup helpers, and lifecycle and operation support
  to provenance results.
- 9065128: Drop-in for existing clients; service consumers can now inspect verified contract-generation facts.
  Advertise understood generations and include a project generation in summaries and status responses
  only when factory provenance and the on-chain core version agree.

## 0.1.0-alpha.33

### Patch Changes

- 9242a05: Prepare package metadata, release notes, and public-facing source comments for the initial public
  source release.
