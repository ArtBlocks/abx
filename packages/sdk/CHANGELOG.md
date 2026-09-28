# @artblocks/abx-sdk

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
