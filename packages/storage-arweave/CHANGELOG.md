# @artblocks/abx-storage-arweave

## 0.1.2

### Patch Changes

- d5a80e1: Drop-in maintenance update for creators and SDK consumers: update production dependencies and normalize missing OS credential records across Keyring versions without retrying denied reads or deleting absent credentials.
- 8e8d38c: Drop-in update for existing Arweave and Ethereum Turbo users: migrate prepaid uploads to Turbo 2, remove the unused x402/browser wallet dependency tree, and retain viem-backed local/remote Ethereum signing and RSA Arweave signing. No new payment mode is enabled.

## 0.1.1

### Patch Changes

- 0be353f: Publish through the main-only GitHub publishing environment and validate each package's restricted npm trusted publisher. Package runtime behavior is unchanged.

## 0.1.0

### Patch Changes

- 3025454: Drop-in for storage users; no ABX API changes. Update the optional Turbo SDK dependency to 1.43.0.
- 8f35dae: Prepare package metadata, release notes, and public-facing source comments for the initial public
  source release.
- d78c369: Use viem for local and remote Ethereum Turbo data-item signing instead of the vulnerable
  ethers-v5/elliptic signer bundled by the upstream dependency tree.

## 0.1.0-alpha.5

### Patch Changes

- d78c369: Use viem for local and remote Ethereum Turbo data-item signing instead of the vulnerable
  ethers-v5/elliptic signer bundled by the upstream dependency tree.

## 0.1.0-alpha.4

### Patch Changes

- 3025454: Drop-in for storage users; no ABX API changes. Update the optional Turbo SDK dependency to 1.43.0.

## 0.1.0-alpha.3

### Patch Changes

- 9242a05: Prepare package metadata, release notes, and public-facing source comments for the initial public
  source release.
