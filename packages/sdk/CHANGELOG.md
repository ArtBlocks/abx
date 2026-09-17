# @artblocks/abx-sdk

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
