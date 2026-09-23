# @artblocks/abx-cli

## 0.1.0-alpha.57

### Patch Changes

- 5164922: Teach the bundled agent skill to prefer live-advertised gas sponsorship for eligible operations while
  keeping hot-key, browser-wallet, and unsigned signing as first-class choices.

## 0.1.0-alpha.56

### Minor Changes

- ea57f7a: Add provider-neutral remote interface discovery, the ABX Creators account API client, and the Base
  Sepolia creator-wallet `--sponsor` signing lane. A provider catalog may advertise its account and
  wallet interfaces at a separate HTTPS origin without changing existing same-origin remotes.

### Patch Changes

- f9ba363: Clarify edition live-supply caps, intentional ERC-721 self-transfer hook callbacks, and OP Stack
  seed-source behavior in the bundled ABX skill.
- Updated dependencies [ea57f7a]
  - @artblocks/abx-sdk@0.1.0-alpha.42
  - @artblocks/abx-indexer@0.1.0-alpha.43
  - @artblocks/abx-storage@0.1.0-alpha.42
  - @artblocks/abx-token-api@0.1.0-alpha.45

## 0.1.0-alpha.55

### Patch Changes

- 8ccbede: Enable Robinhood Chain production as beta after canonical deployment, paired-testnet qualification,
  and managed-service validation. Surface the same real-funds warning and testnet-first gate used for
  other production beta networks.
- Updated dependencies [8ccbede]
  - @artblocks/abx-sdk@0.1.0-alpha.41
  - @artblocks/abx-indexer@0.1.0-alpha.42
  - @artblocks/abx-storage@0.1.0-alpha.41
  - @artblocks/abx-token-api@0.1.0-alpha.44

## 0.1.0-alpha.54

### Patch Changes

- f9d7a44: Clarify fully on-chain image deployment tradeoffs and make static-project verification report
  `onChainUri.chainComplete` as not applicable instead of false.
- ee24497: Add machine-readable `--json` output to `contracturi` and `add`. Collection metadata reads now emit
  the resolved document alone, while registration reports identify the target surface, chain and
  address, scan floor, lifecycle status, and whether remote catch-up is complete or still backfilling.
- Updated dependencies [b9197bc]
  - @artblocks/abx-sdk@0.1.0-alpha.40
  - @artblocks/abx-indexer@0.1.0-alpha.41
  - @artblocks/abx-storage@0.1.0-alpha.40
  - @artblocks/abx-token-api@0.1.0-alpha.43

## 0.1.0-alpha.53

### Patch Changes

- d50cecd: Classify env-key signing risk from the shared chain registry so newly supported testnets, including
  Robinhood Chain Testnet, work in bounded autonomous smoke tests without being mistaken for mainnet.
  The contributor smoke runner now pins one testnet, gives the worker a fresh small-funded wallet,
  copies only the requested hosted-provider credential, and records evidence without per-transaction
  prompts. Remote discovery accepts `remote list`, and on-chain image planning now calls out the
  single-transaction inline-SVG alternative when it applies.

## 0.1.0-alpha.52

### Patch Changes

- 3d7fe3c: Record the verified canonical Robinhood Chain Testnet deployment and enable the network for
  experimental qualification with explicit CLI and agent guidance.
- Updated dependencies [3d7fe3c]
- Updated dependencies [7b462e2]
  - @artblocks/abx-sdk@0.1.0-alpha.39
  - @artblocks/abx-indexer@0.1.0-alpha.40
  - @artblocks/abx-storage@0.1.0-alpha.39
  - @artblocks/abx-token-api@0.1.0-alpha.42

## 0.1.0-alpha.51

### Patch Changes

- c2400a7: Stage Robinhood Chain and its testnet as disabled qualification targets, keep the network registry
  focused on the current roadmap, and stop sale inspection from turning RPC read failures into false
  zero-state results.
- Updated dependencies [c2400a7]
  - @artblocks/abx-sdk@0.1.0-alpha.38
  - @artblocks/abx-indexer@0.1.0-alpha.39
  - @artblocks/abx-storage@0.1.0-alpha.38
  - @artblocks/abx-token-api@0.1.0-alpha.41

## 0.1.0-alpha.50

### Patch Changes

- 4512962: Enable Base production as beta, add a keyless read fallback, and surface production risk and paired-testnet guidance in the CLI, agent skill, and public docs.
- Updated dependencies [4512962]
  - @artblocks/abx-sdk@0.1.0-alpha.37
  - @artblocks/abx-indexer@0.1.0-alpha.38
  - @artblocks/abx-storage@0.1.0-alpha.37
  - @artblocks/abx-token-api@0.1.0-alpha.40

## 0.1.0-alpha.49

### Patch Changes

- Updated dependencies [5522192]
  - @artblocks/abx-sdk@0.1.0-alpha.36
  - @artblocks/abx-indexer@0.1.0-alpha.37
  - @artblocks/abx-storage@0.1.0-alpha.36
  - @artblocks/abx-token-api@0.1.0-alpha.39

## 0.1.0-alpha.48

### Patch Changes

- 70d2761: Make release-candidate automation fail closed: accept the documented hot-signing flag for code
  editions, simulate purchase dry-runs as the configured hot signer, and return a failed exit status
  when any requested render fails.

## 0.1.0-alpha.46

### Patch Changes

- b6f941d: Preserve authorship fields in exact deploy replay commands, keep deferred-mint staging narration
  accurate, and distinguish chain-resident image bytes from independently hash-verified content.

## 0.1.0-alpha.45

### Minor Changes

- 21e3d6c: Drop-in for existing v2 integrations; new deployments use the v3 production-candidate contracts.
  Record the synchronized v3 factory generation and testnet deployments, retain full v2 service
  compatibility (including already-assigned v2 sale minters), and update the renderer scaffold to
  `abx-contracts` 3.0.0.

### Patch Changes

- Updated dependencies [21e3d6c]
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
