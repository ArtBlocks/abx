# @artblocks/abx-token-api

## 0.1.0-alpha.38

### Minor Changes

- 21e3d6c: Drop-in for existing v2 integrations; new deployments use the v3 production-candidate contracts.
  Record the synchronized v3 factory generation and testnet deployments, retain full v2 service
  compatibility (including already-assigned v2 sale minters), and update the renderer scaffold to
  `abx-contracts` 3.0.0.

### Patch Changes

- Updated dependencies [21e3d6c]
- Updated dependencies [a73922c]
  - @artblocks/abx-sdk@0.1.0-alpha.35
  - @artblocks/abx-indexer@0.1.0-alpha.36
  - @artblocks/abx-storage@0.1.0-alpha.35

## 0.1.0-alpha.37

### Minor Changes

- 9065128: Drop-in for existing clients; service consumers can now inspect verified contract-generation facts.
  Advertise understood generations and include a project generation in summaries and status responses
  only when factory provenance and the on-chain core version agree.

### Patch Changes

- Updated dependencies [3ddba71]
- Updated dependencies [9065128]
  - @artblocks/abx-sdk@0.1.0-alpha.34
  - @artblocks/abx-storage@0.1.0-alpha.34
  - @artblocks/abx-indexer@0.1.0-alpha.35

## 0.1.0-alpha.36

### Patch Changes

- 9242a05: Prepare package metadata, release notes, and public-facing source comments for the initial public
  source release.
- Updated dependencies [9242a05]
  - @artblocks/abx-indexer@0.1.0-alpha.34
  - @artblocks/abx-sdk@0.1.0-alpha.33
  - @artblocks/abx-storage@0.1.0-alpha.33
