# @artblocks/abx-cli

## 0.1.0-alpha.45

### Minor Changes

- 21e3d6c: Drop-in for existing v2 integrations; new deployments use the v3 production-candidate contracts.
  Record the synchronized v3 factory generation and testnet deployments, retain full v2 service
  compatibility (including already-assigned v2 sale minters), and update the renderer scaffold to
  `abx-contracts` 3.0.0.
- a73922c: Add a typed, machine-readable chain-support registry. Deploy and record canonical contracts for
  explicit Arbitrum Sepolia qualification while keeping Base, Arbitrum One, and Ethereum disabled until
  production launch gates are complete.

### Patch Changes

- Updated dependencies [21e3d6c]
- Updated dependencies [a73922c]
  - @artblocks/abx-sdk@0.1.0-alpha.35
  - @artblocks/abx-token-api@0.1.0-alpha.38
  - @artblocks/abx-indexer@0.1.0-alpha.36
  - @artblocks/abx-storage@0.1.0-alpha.35

## 0.1.0-alpha.44

### Patch Changes

- Updated dependencies [3ddba71]
- Updated dependencies [9065128]
  - @artblocks/abx-sdk@0.1.0-alpha.34
  - @artblocks/abx-token-api@0.1.0-alpha.37
  - @artblocks/abx-storage@0.1.0-alpha.34
  - @artblocks/abx-indexer@0.1.0-alpha.35

## 0.1.0-alpha.43

### Patch Changes

- 9242a05: Prepare package metadata, release notes, and public-facing source comments for the initial public
  source release.
- Updated dependencies [9242a05]
  - @artblocks/abx-indexer@0.1.0-alpha.34
  - @artblocks/abx-sdk@0.1.0-alpha.33
  - @artblocks/abx-storage@0.1.0-alpha.33
  - @artblocks/abx-token-api@0.1.0-alpha.36
