# @artblocks/abx-sdk

## 0.1.0-alpha.35

### Minor Changes

- 21e3d6c: Drop-in for existing v2 integrations; new deployments use the v3 production-candidate contracts.
  Record the synchronized v3 factory generation and testnet deployments, retain full v2 service
  compatibility (including already-assigned v2 sale minters), and update the renderer scaffold to
  `abx-contracts` 3.0.0.
- a73922c: Add a typed, machine-readable chain-support registry. Deploy and record canonical contracts for
  explicit Arbitrum Sepolia qualification while keeping Base, Arbitrum One, and Ethereum disabled until
  production launch gates are complete.

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
