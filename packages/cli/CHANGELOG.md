# @artblocks/abx-cli

## 0.1.0-alpha.67

### Patch Changes

- 56973c4: Preserve `maxInvocations` as an exact uint256 value instead of narrowing it through a JavaScript
  number. Reuse an existing hosted-service credential on login and add self-service API-key listing
  and revocation for accounts at their active-key limit.
- Updated dependencies [56973c4]
  - @artblocks/abx-sdk@0.1.0-alpha.47
  - @artblocks/abx-indexer@0.1.0-alpha.48
  - @artblocks/abx-storage@0.1.0-alpha.47
  - @artblocks/abx-token-api@0.1.0-alpha.50

## 0.1.0-alpha.66

### Patch Changes

- ddb2e0b: Refuse irreversible URI locks when the current token or collection base uses `abx.io`. Clarify that
  managed resolver URLs must remain mutable unless a creator-controlled domain is routed and verified.
- 76cfc6a: Follow each remote service interface's advertised origin so provider catalogs can separate token data from account and control APIs.
- Updated dependencies [ddb2e0b]
- Updated dependencies [76cfc6a]
  - @artblocks/abx-sdk@0.1.0-alpha.46
  - @artblocks/abx-indexer@0.1.0-alpha.47
  - @artblocks/abx-storage@0.1.0-alpha.46
  - @artblocks/abx-token-api@0.1.0-alpha.49

## 0.1.0-alpha.65

### Patch Changes

- 66cf489: Mark the qualified creator-wallet sponsorship lane as supported while preserving Base mainnet's protocol-beta warnings.

## 0.1.0-alpha.64

### Patch Changes

- 90bde50: Document the supported creator-wallet sponsorship lane in hook, mint, and transfer command help.

## 0.1.0-alpha.63

### Patch Changes

- d925eb1: Breaking only for SDK callers that directly prepared an unsupported sponsored `to: null` request;
  drop-in for existing hot, wallet, and unsigned deployments. Route sponsored custom-contract
  deployments through ABX's existing keyless CREATE2 proxy, expose the exact signer-bound salt and
  predicted address, verify code after confirmation, and document the proxy constructor-caller boundary.
- Updated dependencies [d925eb1]
  - @artblocks/abx-sdk@0.1.0-alpha.45
  - @artblocks/abx-indexer@0.1.0-alpha.46
  - @artblocks/abx-storage@0.1.0-alpha.45
  - @artblocks/abx-token-api@0.1.0-alpha.48

## 0.1.0-alpha.62

### Minor Changes

- 22abce8: Generalize the creator-wallet sponsorship lane to direct zero-value contract creation and
  receipt-dependent on-chain image staging. Add `abx deploy-contract` for exact Foundry artifact or
  initcode deployment through any signing lane.

### Patch Changes

- Updated dependencies [22abce8]
  - @artblocks/abx-sdk@0.1.0-alpha.44
  - @artblocks/abx-indexer@0.1.0-alpha.45
  - @artblocks/abx-storage@0.1.0-alpha.44
  - @artblocks/abx-token-api@0.1.0-alpha.47

## 0.1.0-alpha.61

### Patch Changes

- 04c0919: Remove ABX's artificial 3,000,000-gas ceiling from sponsored transactions. Sponsored calls now use
  the network estimate and remain subject to the active chain and provider sponsorship policy.

## 0.1.0-alpha.60

### Patch Changes

- 2290b0a: Recover ambiguous creator-wallet submissions through the existing operation status instead of replaying them. Sponsored sends now keep polling safely when the provider response is temporarily unknown and surface the operation ID if reconciliation cannot complete.
- Updated dependencies [2290b0a]
  - @artblocks/abx-sdk@0.1.0-alpha.43
  - @artblocks/abx-indexer@0.1.0-alpha.44
  - @artblocks/abx-storage@0.1.0-alpha.43
  - @artblocks/abx-token-api@0.1.0-alpha.46

## 0.1.0-alpha.59

### Patch Changes

- c324a8f: Make sponsored deployment previews resolve the existing ABX creator wallet without provisioning external state, so the preview and real send use the same owner, mint recipient, and deterministic salt.

## 0.1.0-alpha.58

### Patch Changes

- b8f2876: Keep sponsored deploy guidance consistent: an ABX creator wallet no longer receives a faucet warning when its native balance is intentionally zero.
- e89896a: Reject deterministic deploy salts reserved to a different signer before authorization or broadcast.
- cf2708c: Allow the beta creator-wallet sponsorship lane on Base mainnet when the live provider and account explicitly advertise eligibility, while retaining Base Sepolia as the recommended first run.

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
